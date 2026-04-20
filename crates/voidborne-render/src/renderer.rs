//! [`VoidborneRenderer`] — the public entry point for the render crate.
//!
//! Usage:
//! ```no_run
//! let mut r = VoidborneRenderer::new(window);
//! // Each frame:
//! r.update_frame(frame_data);
//! r.render();
//! ```

use bytemuck;
use std::sync::Arc;
use wgpu;
use wgpu::util::DeviceExt;
use winit::window::Window;

use voidborne_math::coord::ChunkPos;
use voidborne_world::mesh::SectionMesh;

use crate::context::GpuContext;
use crate::frame_data::{CascadeUBO, ChunkOriginUBO, FrameData, FrameUBO};
use crate::mesh::{ChunkEntry, GpuMesh};
use crate::passes::{
    gbuffer::GbufferPass,
    lighting::LightingPass,
    motion_blur::{MotionBlurPass, MotionBlurSettings},
    overlay::OverlayPass,
    post::PostPass,
    shadow::ShadowPass,
    sky::SkyPass,
};
use crate::texture_pool::TexturePool;

// ── Terrain atlas ─────────────────────────────────────────────────────
//
// 16×16-pixel procedural tiles stored as a `texture_2d_array`.
// Format: `Rgba8UnormSrgb` — RGB holds sRGB albedo (GPU decodes to
// linear on sample); alpha holds **roughness** encoded so that solid
// blocks always pass the G-buffer alpha-discard test:
//
//   alpha_stored = 0.5 + roughness * 0.5   ∈ [0.502, 1.0]
//
// The G-buffer shader extracts roughness with:
//   roughness = clamp((a - 0.5) * 2.0, 0.0, 1.0)
//
// Tile layout (matches face_tiles in block.rs):
//   0  grass_top     5  iron_ore     10 redstone_ore
//   1  grass_side    6  gold_ore     11 copper_ore
//   2  dirt          7  diamond_ore  12-15 reserved
//   3  stone         8  emerald_ore
//   4  coal_ore      9  lapis_ore

const ATLAS_TILE: u32 = 16;
const ATLAS_LAYERS: u32 = 16;

/// Cheap integer hash → [0.0, 1.0].
fn tile_hash(x: u32, y: u32, seed: u32) -> f32 {
    let h = x
        .wrapping_mul(1_234_567_891)
        .wrapping_add(y.wrapping_mul(987_654_321))
        .wrapping_add(seed.wrapping_mul(2_246_822_519));
    let h = h ^ (h >> 13);
    let h = h.wrapping_mul(1_274_126_177);
    let h = h ^ (h >> 16);
    h as f32 / u32::MAX as f32
}

fn lerp_ch(a: u8, b: u8, t: f32) -> u8 {
    (a as f32 + (b as f32 - a as f32) * t).clamp(0.0, 255.0) as u8
}

/// Encode roughness into an alpha byte that always passes the 0.5
/// transparency test used by the G-buffer shader.
fn roughness_alpha(r: f32) -> u8 {
    (128.0 + r.clamp(0.0, 1.0) * 127.0).round() as u8
}

/// Generate one 16×16 RGBA tile (sRGB albedo, linear-roughness alpha).
///
/// `base`      — base sRGB colour [r,g,b]
/// `variation` — colour noise strength [0,1]
/// `roughness` — PBR roughness
/// `ore`       — optional (ore_sRGB_colour, spot_probability)
fn gen_tile(
    base: [u8; 3],
    variation: f32,
    roughness: f32,
    ore: Option<([u8; 3], f32)>,
    seed: u32,
) -> Vec<u8> {
    let n = ATLAS_TILE;
    let mut out = Vec::with_capacity((n * n * 4) as usize);
    let alpha = roughness_alpha(roughness);
    for y in 0..n {
        for x in 0..n {
            let noise = tile_hash(x, y, seed);
            let is_ore = ore
                .map(|(_, freq)| tile_hash(x + 100, y + 200, seed + 1) < freq)
                .unwrap_or(false);
            let (r, g, b) = if is_ore {
                let oc = ore.unwrap().0;
                let t = 0.65 + tile_hash(x + 50, y + 50, seed + 2) * 0.35;
                (
                    lerp_ch(base[0], oc[0], t),
                    lerp_ch(base[1], oc[1], t),
                    lerp_ch(base[2], oc[2], t),
                )
            } else {
                let v = (noise - 0.5) * variation * 64.0;
                (
                    (base[0] as f32 + v).clamp(0.0, 255.0) as u8,
                    (base[1] as f32 + v).clamp(0.0, 255.0) as u8,
                    (base[2] as f32 + v).clamp(0.0, 255.0) as u8,
                )
            };
            out.extend_from_slice(&[r, g, b, alpha]);
        }
    }
    out
}

/// Tile 1 — grass side: top rows green, rest dirt.
fn gen_grass_side(seed: u32) -> Vec<u8> {
    let n = ATLAS_TILE;
    let mut out = Vec::with_capacity((n * n * 4) as usize);
    let grass = [91u8, 138, 42];
    let dirt = [139u8, 94, 60];
    for y in 0..n {
        let (base, roughness) = if y < 4 {
            (grass, 0.75_f32)
        } else {
            (dirt, 0.88_f32)
        };
        let alpha = roughness_alpha(roughness);
        for x in 0..n {
            let noise = tile_hash(x, y, seed);
            let v = (noise - 0.5) * 0.28 * 64.0;
            let r = (base[0] as f32 + v).clamp(0.0, 255.0) as u8;
            let g = (base[1] as f32 + v).clamp(0.0, 255.0) as u8;
            let b = (base[2] as f32 + v).clamp(0.0, 255.0) as u8;
            out.extend_from_slice(&[r, g, b, alpha]);
        }
    }
    out
}

/// Stone-base ore tile: stone background + coloured ore veins.
fn gen_ore_tile(ore_rgb: [u8; 3], roughness: f32, freq: f32, seed: u32) -> Vec<u8> {
    gen_tile(
        [130, 130, 130],
        0.18,
        roughness,
        Some((ore_rgb, freq)),
        seed,
    )
}

fn make_terrain_atlas(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> (wgpu::Texture, wgpu::TextureView, wgpu::Sampler) {
    let n = ATLAS_TILE;
    let layers = ATLAS_LAYERS;

    // Generate all tile data in atlas-layer order.
    let tiles: Vec<Vec<u8>> = vec![
        // 0  grass_top
        gen_tile([91, 138, 42], 0.22, 0.75, None, 0),
        // 1  grass_side (special: top=green, rest=dirt)
        gen_grass_side(1),
        // 2  dirt
        gen_tile([139, 94, 60], 0.26, 0.88, None, 2),
        // 3  stone
        gen_tile([130, 130, 130], 0.18, 0.92, None, 3),
        // 4  coal_ore
        gen_ore_tile([40, 40, 40], 0.90, 0.12, 4),
        // 5  iron_ore
        gen_ore_tile([212, 147, 95], 0.85, 0.10, 5),
        // 6  gold_ore
        gen_ore_tile([240, 192, 32], 0.80, 0.09, 6),
        // 7  diamond_ore
        gen_ore_tile([80, 220, 232], 0.65, 0.08, 7),
        // 8  emerald_ore
        gen_ore_tile([48, 200, 96], 0.70, 0.08, 8),
        // 9  lapis_ore
        gen_ore_tile([32, 80, 200], 0.85, 0.14, 9),
        // 10 redstone_ore
        gen_ore_tile([200, 32, 32], 0.82, 0.13, 10),
        // 11 copper_ore
        gen_ore_tile([224, 128, 64], 0.85, 0.11, 11),
        // 12-15 reserved — solid mid-gray placeholder
        gen_tile([160, 160, 160], 0.0, 0.90, None, 12),
        gen_tile([160, 160, 160], 0.0, 0.90, None, 13),
        gen_tile([160, 160, 160], 0.0, 0.90, None, 14),
        gen_tile([160, 160, 160], 0.0, 0.90, None, 15),
    ];
    assert_eq!(tiles.len(), layers as usize);

    // Flatten into a single contiguous buffer, layer-major.
    let tile_bytes = (n * n * 4) as usize;
    let mut data = Vec::with_capacity(tile_bytes * layers as usize);
    for t in &tiles {
        assert_eq!(t.len(), tile_bytes);
        data.extend_from_slice(t);
    }

    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("terrain_atlas"),
        size: wgpu::Extent3d {
            width: n,
            height: n,
            depth_or_array_layers: layers,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        // sRGB: GPU decodes RGB to linear on sample; alpha stays linear
        // (used for roughness encoding, not colour).
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
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
            bytes_per_row: Some(4 * n),
            rows_per_image: Some(n),
        },
        wgpu::Extent3d {
            width: n,
            height: n,
            depth_or_array_layers: layers,
        },
    );
    let view = texture.create_view(&Default::default());
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("atlas_sampler"),
        // Nearest-neighbour preserves pixel-art crispness on block faces.
        mag_filter: wgpu::FilterMode::Nearest,
        min_filter: wgpu::FilterMode::Nearest,
        mipmap_filter: wgpu::FilterMode::Nearest,
        ..Default::default()
    });
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
    frame_bg: wgpu::BindGroup,
    /// Shared frame bind group layout (group 0 for G-buffer + lighting).
    _frame_bgl: wgpu::BindGroupLayout,

    // ── Cascade UBO (for lighting pass group 0 binding 1) ──
    cascade_buf: wgpu::Buffer,
    /// Combined frame+cascade bind group used by lighting pass.
    lighting_frame_bg: wgpu::BindGroup,

    // ── Atlas ────────────────────────────────────────────
    _atlas_tex: wgpu::Texture,
    atlas_bg: wgpu::BindGroup,

    // ── Passes ───────────────────────────────────────────
    gbuffer: GbufferPass,
    shadow: ShadowPass,
    lighting: LightingPass,
    sky: SkyPass,
    motion_blur: MotionBlurPass,
    post: PostPass,
    overlay: OverlayPass,

    // ── egui ─────────────────────────────────────────────
    egui_renderer: egui_wgpu::Renderer,

    // ── Chunk mesh store ─────────────────────────────────
    chunks: Vec<ChunkEntry>,

    pub frame_data: FrameData,
}

impl VoidborneRenderer {
    /// Create the renderer from a `winit` window.
    pub fn new(window: Arc<Window>) -> Self {
        let ctx = GpuContext::new(window);
        let device = &ctx.device;
        let queue = &ctx.queue;
        let w = ctx.width();
        let h = ctx.height();

        // ── Texture pool ─────────────────────────────────
        let mut pool = TexturePool::new();
        pool.rebuild(device, w, h);

        // ── Shared frame bind group layout ───────────────
        let frame_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("shared_frame_bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        // ── Frame UBO buffer + bind group ────────────────
        let fd = FrameData::default();
        let frame_ubo = FrameUBO::from_data(&fd, w, h);
        let frame_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("frame_ubo"),
            contents: bytemuck::bytes_of(&frame_ubo),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let frame_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("frame_bg"),
            layout: &frame_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: frame_buf.as_entire_binding(),
            }],
        });

        // ── Cascade UBO ───────────────────────────────────
        let _cascade_ubo = CascadeUBO {
            view_proj: [bytemuck::Zeroable::zeroed(); 4],
        };
        // We store CascadeUBO + a vec4 splits field.
        // For the lighting shader which has:
        //   view_proj: array<mat4x4<f32>, 4>  → 256 B
        //   splits:    vec4<f32>              →  16 B
        // Total: 272 B. Use a raw buffer filled with zeros for now.
        let cascade_data = vec![0u8; 272];
        let cascade_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("cascade_ubo"),
            contents: &cascade_data,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // ── Passes ───────────────────────────────────────
        let gbuffer = GbufferPass::new(device, &pool);
        let shadow = ShadowPass::new(device);
        let lighting = LightingPass::new(device, &pool, ctx.surface_format);
        let sky = SkyPass::load_from_disk(
            device,
            queue,
            &pool,
            pool.format(crate::texture_pool::handles::HDR),
            &frame_bgl,
            "assets/skybox/void.png",
        );
        let motion_blur = MotionBlurPass::new(device, &pool);
        let post = PostPass::new(device, queue, &pool, ctx.surface_format);
        let overlay = OverlayPass::new(device, ctx.surface_format);

        let egui_renderer = egui_wgpu::Renderer::new(device, ctx.surface_format, None, 1, false);

        // ── Combined lighting frame+cascade bind group ───
        let lighting_frame_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
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
        });

        // ── Terrain atlas ─────────────────────────────────
        let (_atlas_tex, atlas_view, atlas_sampler) = make_terrain_atlas(device, queue);
        let atlas_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("atlas_bg"),
            layout: &gbuffer.atlas_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&atlas_sampler),
                },
            ],
        });

        Self {
            ctx,
            pool,
            frame_buf,
            frame_bg,
            _frame_bgl: frame_bgl,
            cascade_buf,
            lighting_frame_bg,
            _atlas_tex,
            atlas_bg,
            gbuffer,
            shadow,
            lighting,
            sky,
            motion_blur,
            post,
            overlay,
            egui_renderer,
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
        let origin_buf = self
            .ctx
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("chunk_origin"),
                contents: bytemuck::bytes_of(&origin),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let chunk_bg = self
            .ctx
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("chunk_bg"),
                layout: &self.gbuffer.chunk_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: origin_buf.as_entire_binding(),
                }],
            });
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
        let ubo = FrameUBO::from_data(&self.frame_data, self.ctx.width(), self.ctx.height());
        self.ctx
            .queue
            .write_buffer(&self.frame_buf, 0, bytemuck::bytes_of(&ubo));
    }

    // ── egui ──────────────────────────────────────────────

    /// Upload / free egui textures.  Call before `render()`.
    pub fn apply_egui_textures(&mut self, delta: &egui::TexturesDelta) {
        for (id, image_delta) in &delta.set {
            self.egui_renderer
                .update_texture(&self.ctx.device, &self.ctx.queue, *id, image_delta);
        }
        for id in &delta.free {
            self.egui_renderer.free_texture(id);
        }
    }

    /// Maximum texture dimension supported by this adapter.
    pub fn max_texture_side(&self) -> usize {
        self.ctx.device.limits().max_texture_dimension_2d as usize
    }

    /// Apply new motion-blur settings.
    pub fn update_motion_blur(&mut self, settings: MotionBlurSettings) {
        self.motion_blur.update_settings(&self.ctx.queue, settings);
    }

    /// Render one frame to the swapchain.
    ///
    /// * `targeted_block` — world-space integer block coords for the selection
    ///   outline, or `None` when no block is targeted.
    /// * `egui` — optional `(primitives, screen_descriptor)` produced by egui.
    ///
    /// Returns `Err(wgpu::SurfaceError::...)` on transient surface errors.
    pub fn render(
        &mut self,
        targeted_block: Option<[i32; 3]>,
        egui: Option<(&[egui::ClippedPrimitive], &egui_wgpu::ScreenDescriptor)>,
    ) -> Result<(), wgpu::SurfaceError> {
        let surface_tex = self.ctx.surface.get_current_texture()?;
        let surface_view = surface_tex.texture.create_view(&Default::default());

        let device = &self.ctx.device;
        let queue = &self.ctx.queue;
        let pool = &self.pool;

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("voidborne-frame"),
        });

        // ── Shadow pass (4 cascades) ──────────────────────
        // For M1 we use identity cascades (no real light frusta yet).
        if let Some(sv) = &pool.shadow_views {
            for i in 0..4usize {
                let cascade_vp: [[f32; 16]; 4] = [[0f32; 16]; 4];
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
        self.lighting
            .record(&mut encoder, pool, &self.lighting_frame_bg);

        // ── Skybox (equirect, fills sky pixels in HDR) ────
        self.sky.record(&mut encoder, pool, &self.frame_bg);

        // ── Motion blur (HDR + velocity → MOTION_BLUR_HDR) ─
        self.motion_blur.record(&mut encoder, pool);

        // ── Tonemap → swapchain ───────────────────────────
        self.post.record(&mut encoder, &surface_view);

        // ── Overlay (outline + crosshair) ─────────────────
        self.overlay.record(
            &mut encoder,
            queue,
            &surface_view,
            pool,
            &self.frame_bg,
            targeted_block,
        );

        // ── egui ──────────────────────────────────────────
        if let Some((primitives, screen_desc)) = egui {
            // Upload vertex/index buffers; may return extra command buffers.
            let mut extra = self.egui_renderer.update_buffers(
                device,
                queue,
                &mut encoder,
                primitives,
                screen_desc,
            );
            {
                let mut pass = encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("egui"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &surface_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        ..Default::default()
                    })
                    .forget_lifetime();
                self.egui_renderer
                    .render(&mut pass, primitives, screen_desc);
            }
            extra.push(encoder.finish());
            queue.submit(extra);
        } else {
            queue.submit([encoder.finish()]);
        }
        surface_tex.present();

        Ok(())
    }

    // ── Resize ────────────────────────────────────────────

    /// Handle window resize.
    pub fn resize(&mut self, width: u32, height: u32) {
        // Ignore zero-size resize events (e.g. minimized window).
        if width == 0 || height == 0 {
            return;
        }
        self.ctx.resize(width, height);
        self.pool.rebuild(&self.ctx.device, width, height);

        // Rebuild bind groups that reference screen-size textures.
        self.lighting.rebuild_gbuf_bg(&self.ctx.device, &self.pool);
        self.sky.rebuild_sky_bg(&self.ctx.device, &self.pool);
        self.motion_blur
            .rebuild_tex_bg(&self.ctx.device, &self.pool);
        self.post.rebuild_hdr_bg(&self.ctx.device, &self.pool);

        // Re-create lighting_frame_bg (layout may reuse same buffers).
        self.lighting_frame_bg = self
            .ctx
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("lighting_frame_bg"),
                layout: &self.lighting.frame_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.frame_buf.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: self.cascade_buf.as_entire_binding(),
                    },
                ],
            });
    }

    /// Change the swapchain present mode (V-Sync on/off) without a full resize.
    pub fn set_present_mode(&mut self, mode: wgpu::PresentMode) {
        self.ctx.set_present_mode(mode);
    }

    pub fn ctx_width(&self) -> u32 {
        self.ctx.width()
    }

    pub fn ctx_height(&self) -> u32 {
        self.ctx.height()
    }
}
