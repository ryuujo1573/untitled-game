//! [`VoidborneRenderer`] — the public entry point for the render crate.
//!
//! Usage:
//! ```no_run
//! let mut r = VoidborneRenderer::new(window);
//! // Each frame:
//! r.update_frame(frame_data);
//! r.render();
//! ```

use std::sync::Arc;
use bytemuck;
use wgpu;
use wgpu::util::DeviceExt;
use winit::window::Window;

use voidborne_math::coord::ChunkPos;
use voidborne_world::mesh::SectionMesh;

use crate::context::GpuContext;
use crate::frame_data::{
    CascadeUBO, ChunkOriginUBO, FrameData, FrameUBO,
};
use crate::mesh::{ChunkEntry, GpuMesh};
use crate::passes::{
    gbuffer::GbufferPass,
    lighting::LightingPass,
    post::PostPass,
    shadow::ShadowPass,
};
use crate::texture_pool::TexturePool;

// ── Placeholder atlas (1 white pixel per layer, 12 layers) ────────

fn make_placeholder_atlas(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> (wgpu::Texture, wgpu::TextureView, wgpu::Sampler) {
    const LAYERS: u32 = 16;
    let data: Vec<u8> = vec![255u8; (LAYERS * 4) as usize]; // RGBA white
    let texture = device.create_texture(
        &wgpu::TextureDescriptor {
            label: Some("placeholder_atlas"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: LAYERS,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
    );
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &data,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4),
            rows_per_image: Some(1),
        },
        wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: LAYERS,
        },
    );
    let view = texture.create_view(&Default::default());
    let sampler = device.create_sampler(
        &wgpu::SamplerDescriptor {
            label: Some("atlas_sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        },
    );
    (texture, view, sampler)
}

// ── VoidborneRenderer ────────────────────────────────────────────────

/// The renderer.  Create once per window; keep alive for the lifetime
/// of the application.
pub struct VoidborneRenderer {
    ctx: GpuContext,
    pool: TexturePool,

    // ── Frame UBO ────────────────────────────────────────
    frame_buf: wgpu::Buffer,
    frame_bg:  wgpu::BindGroup,
    /// Shared frame bind group layout (group 0 for G-buffer + lighting).
    frame_bgl: wgpu::BindGroupLayout,

    // ── Cascade UBO (for lighting pass group 0 binding 1) ──
    cascade_buf: wgpu::Buffer,
    /// Combined frame+cascade bind group used by lighting pass.
    lighting_frame_bg: wgpu::BindGroup,

    // ── Atlas ────────────────────────────────────────────
    _atlas_tex:  wgpu::Texture,
    atlas_bg:    wgpu::BindGroup,

    // ── Passes ───────────────────────────────────────────
    gbuffer:   GbufferPass,
    shadow:    ShadowPass,
    lighting:  LightingPass,
    post:      PostPass,

    // ── Chunk mesh store ─────────────────────────────────
    chunks: Vec<ChunkEntry>,

    pub frame_data: FrameData,
}

impl VoidborneRenderer {
    /// Create the renderer from a `winit` window.
    pub fn new(window: Arc<Window>) -> Self {
        let ctx = GpuContext::new(window);
        let device = &ctx.device;
        let queue  = &ctx.queue;
        let w = ctx.width();
        let h = ctx.height();

        // ── Texture pool ─────────────────────────────────
        let mut pool = TexturePool::new();
        pool.rebuild(device, w, h);

        // ── Shared frame bind group layout ───────────────
        let frame_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("shared_frame_bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX
                        | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            },
        );

        // ── Frame UBO buffer + bind group ────────────────
        let fd = FrameData::default();
        let frame_ubo = FrameUBO::from_data(&fd, w, h);
        let frame_buf = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("frame_ubo"),
                contents: bytemuck::bytes_of(&frame_ubo),
                usage: wgpu::BufferUsages::UNIFORM
                    | wgpu::BufferUsages::COPY_DST,
            },
        );
        let frame_bg = device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some("frame_bg"),
                layout: &frame_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: frame_buf.as_entire_binding(),
                }],
            },
        );

        // ── Cascade UBO ───────────────────────────────────
        let cascade_ubo = CascadeUBO {
            view_proj: [bytemuck::Zeroable::zeroed(); 4],
        };
        // We store CascadeUBO + a vec4 splits field.
        // For the lighting shader which has:
        //   view_proj: array<mat4x4<f32>, 4>  → 256 B
        //   splits:    vec4<f32>              →  16 B
        // Total: 272 B. Use a raw buffer filled with zeros for now.
        let cascade_data = vec![0u8; 272];
        let cascade_buf = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("cascade_ubo"),
                contents: &cascade_data,
                usage: wgpu::BufferUsages::UNIFORM
                    | wgpu::BufferUsages::COPY_DST,
            },
        );

        // ── Passes ───────────────────────────────────────
        let gbuffer  = GbufferPass::new(device, &pool);
        let shadow   = ShadowPass::new(device);
        let lighting = LightingPass::new(
            device, &pool, ctx.surface_format,
        );
        let post     = PostPass::new(
            device, &pool, ctx.surface_format,
        );

        // ── Combined lighting frame+cascade bind group ───
        let lighting_frame_bg = device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some("lighting_frame_bg"),
                layout: &lighting.frame_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: frame_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: cascade_buf.as_entire_binding(),
                    },
                ],
            },
        );

        // ── Atlas placeholder ─────────────────────────────
        let (_atlas_tex, atlas_view, atlas_sampler) =
            make_placeholder_atlas(device, queue);
        let atlas_bg = device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some("atlas_bg"),
                layout: &gbuffer.atlas_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            &atlas_view,
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(
                            &atlas_sampler,
                        ),
                    },
                ],
            },
        );

        Self {
            ctx,
            pool,
            frame_buf,
            frame_bg,
            frame_bgl,
            cascade_buf,
            lighting_frame_bg,
            _atlas_tex,
            atlas_bg,
            gbuffer,
            shadow,
            lighting,
            post,
            chunks: Vec::new(),
            frame_data: fd,
        }
    }

    // ── Chunk management ─────────────────────────────────

    /// Upload a new section mesh for `pos`.  Replaces any existing mesh.
    pub fn load_chunk(&mut self, pos: ChunkPos, mesh: &SectionMesh) {
        self.unload_chunk(pos);
        let gpu_mesh = match GpuMesh::upload(&self.ctx.device, mesh) {
            Some(m) => m,
            None => return, // empty section
        };
        let origin = {
            let bx = (pos.0.x * 16) as f32;
            let bz = (pos.0.y * 16) as f32;
            ChunkOriginUBO {
                origin: [bx, 0.0, bz, 0.0],
            }
        };
        let origin_buf = self.ctx.device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("chunk_origin"),
                contents: bytemuck::bytes_of(&origin),
                usage: wgpu::BufferUsages::UNIFORM,
            },
        );
        let chunk_bg =
            self.ctx.device.create_bind_group(
                &wgpu::BindGroupDescriptor {
                    label: Some("chunk_bg"),
                    layout: &self.gbuffer.chunk_bgl,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: origin_buf.as_entire_binding(),
                    }],
                },
            );
        self.chunks.push(ChunkEntry {
            pos,
            mesh: gpu_mesh,
            origin_buf,
            chunk_bind_group: chunk_bg,
        });
    }

    /// Remove the mesh for `pos` (if present).
    pub fn unload_chunk(&mut self, pos: ChunkPos) {
        self.chunks.retain(|c| c.pos != pos);
    }

    // ── Frame ─────────────────────────────────────────────

    /// Update the per-frame uniform data.
    pub fn update_frame(&mut self, data: FrameData) {
        self.frame_data = data;
        let ubo = FrameUBO::from_data(
            &self.frame_data,
            self.ctx.width(),
            self.ctx.height(),
        );
        self.ctx.queue.write_buffer(
            &self.frame_buf,
            0,
            bytemuck::bytes_of(&ubo),
        );
    }

    /// Render one frame to the swapchain.
    ///
    /// Returns `Err(wgpu::SurfaceError::...)` on transient surface errors.
    pub fn render(
        &self,
    ) -> Result<(), wgpu::SurfaceError> {
        let surface_tex = self.ctx.surface.get_current_texture()?;
        let surface_view = surface_tex
            .texture
            .create_view(&Default::default());

        let device = &self.ctx.device;
        let queue  = &self.ctx.queue;
        let pool   = &self.pool;

        let mut encoder = device.create_command_encoder(
            &wgpu::CommandEncoderDescriptor {
                label: Some("voidborne-frame"),
            },
        );

        // ── Shadow pass (4 cascades) ──────────────────────
        // For M1 we use identity cascades (no real light frusta yet).
        if let Some(sv) = &pool.shadow_views {
            for i in 0..4usize {
                let cascade_vp: [[f32; 16]; 4] =
                    [[0f32; 16]; 4];
                let pairs: Vec<(_, &wgpu::Buffer)> = self
                    .chunks
                    .iter()
                    .map(|c| (&c.mesh, &c.origin_buf))
                    .collect();
                self.shadow.record_cascade(
                    &mut encoder,
                    device,
                    &sv.cascade[i],
                    cascade_vp,
                    &pairs,
                );
            }
        }

        // ── G-buffer pass ─────────────────────────────────
        {
            let chunk_pairs: Vec<(&GpuMesh, &wgpu::BindGroup)> = self
                .chunks
                .iter()
                .map(|c| (&c.mesh, &c.chunk_bind_group))
                .collect();
            self.gbuffer.record(
                &mut encoder,
                pool,
                &self.frame_bg,
                &self.atlas_bg,
                &chunk_pairs,
            );
        }

        // ── Deferred lighting ─────────────────────────────
        self.lighting.record(
            &mut encoder,
            pool,
            &self.lighting_frame_bg,
        );

        // ── Tonemap → swapchain ───────────────────────────
        self.post.record(&mut encoder, &surface_view);

        queue.submit([encoder.finish()]);
        surface_tex.present();

        Ok(())
    }

    // ── Resize ────────────────────────────────────────────

    /// Handle window resize.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.ctx.resize(width, height);
        self.pool.rebuild(&self.ctx.device, width, height);

        // Rebuild bind groups that reference screen-size textures.
        self.lighting
            .rebuild_gbuf_bg(&self.ctx.device, &self.pool);
        self.post
            .rebuild_hdr_bg(&self.ctx.device, &self.pool);

        // Re-create lighting_frame_bg (layout may reuse same buffers).
        self.lighting_frame_bg =
            self.ctx.device.create_bind_group(
                &wgpu::BindGroupDescriptor {
                    label: Some("lighting_frame_bg"),
                    layout: &self.lighting.frame_bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: self
                                .frame_buf
                                .as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: self
                                .cascade_buf
                                .as_entire_binding(),
                        },
                    ],
                },
            );
    }
}
