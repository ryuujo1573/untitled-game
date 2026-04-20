//! Equirectangular skybox pass.
//!
//! Renders a full-screen triangle that samples an equirectangular
//! panorama texture.  Pixels that already have geometry (depth < 1.0)
//! are discarded in the fragment shader, so this pass must run **after**
//! the deferred-lighting resolve.
//!
//! # Usage
//! ```no_run
//! // At startup – build from raw RGBA bytes:
//! let sky = SkyPass::new(device, queue, &pool, hdr_format, &rgba, w, h);
//!
//! // After resize:
//! sky.rebuild_sky_bg(device, &pool);
//!
//! // Each frame (after lighting pass):
//! sky.record(&mut encoder, &pool, &frame_bg);
//! ```

use crate::texture_pool::{handles, TexturePool};
use wgpu;

// ── fallback: 4×2 deep-purple gradient ───────────────

fn fallback_rgba() -> (Vec<u8>, u32, u32) {
    // A minimal 4×2 equirect: upper half lighter, lower half darker.
    #[rustfmt::skip]
    let pixels: [u8; 4 * 4 * 2] = [
        // row 0 (upper – zenith)
         20,  10, 40, 255,   30, 15, 60, 255,   25, 12, 50, 255,   35, 18, 70, 255,
        // row 1 (lower – nadir)
          5,   2, 10, 255,    8,  4, 16, 255,    6,  3, 12, 255,   10,  5, 20, 255,
    ];
    (pixels.to_vec(), 4, 2)
}

// ── SkyPass ───────────────────────────────────────────

/// Equirectangular skybox render pass.
pub struct SkyPass {
    pub pipeline: wgpu::RenderPipeline,
    /// Layout for group 0: FrameUBO.
    pub frame_bgl: wgpu::BindGroupLayout,
    /// Layout for group 1: equirect + depth + sampler.
    pub sky_bgl: wgpu::BindGroupLayout,
    /// Bind group for group 1 (rebuilt on resize because depth_tex changes).
    pub sky_bg: Option<wgpu::BindGroup>,
    /// Linear sampler for the equirect panorama.
    pub sampler: wgpu::Sampler,
    /// The equirect panorama texture on the GPU.
    pub equirect_tex: wgpu::Texture,
    pub equirect_view: wgpu::TextureView,
}

impl SkyPass {
    /// Create the pass.
    ///
    /// `rgba` must be `width × height` RGBA8 pixels (row-major, top-to-bottom).
    /// Pass the decoded bytes from an equirectangular PNG.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pool: &TexturePool,
        hdr_format: wgpu::TextureFormat,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Self {
        // ── Equirect texture ─────────────────────────────
        let equirect_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("sky_equirect"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &equirect_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * width),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let equirect_view = equirect_tex.create_view(&Default::default());

        // ── Sampler ──────────────────────────────────────
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("sky_sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        // ── Bind group layouts ───────────────────────────
        let frame_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sky_frame_bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let sky_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sky_bgl"),
            entries: &[
                // 0: equirect texture
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                // 1: depth texture (read-only, depth aspect only)
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Depth,
                    },
                    count: None,
                },
                // 2: sampler (filtering)
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        // ── Pipeline ─────────────────────────────────────
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("sky_layout"),
            bind_group_layouts: &[&frame_bgl, &sky_bgl],
            push_constant_ranges: &[],
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("sky_equirect"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../shaders/sky_equirect.wgsl").into(),
            ),
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("sky_pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_fullscreen"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: hdr_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let mut pass = Self {
            pipeline,
            frame_bgl,
            sky_bgl,
            sky_bg: None,
            sampler,
            equirect_tex,
            equirect_view,
        };
        pass.rebuild_sky_bg(device, pool);
        pass
    }

    /// Load `void.png` from disk, falling back to a built-in
    /// 4×2 purple gradient if the file is missing or unreadable.
    pub fn load_from_disk(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pool: &TexturePool,
        hdr_format: wgpu::TextureFormat,
        path: &str,
    ) -> Self {
        let (rgba, w, h) = load_png(path);
        Self::new(device, queue, pool, hdr_format, &rgba, w, h)
    }

    /// Rebuild the sky bind group.  Must be called after any pool resize
    /// because the depth texture view changes.
    pub fn rebuild_sky_bg(&mut self, device: &wgpu::Device, pool: &TexturePool) {
        // The depth buffer is Depth24PlusStencil8; bind depth aspect only.
        let depth_view =
            pool.get(handles::DEPTH)
                .texture
                .create_view(&wgpu::TextureViewDescriptor {
                    aspect: wgpu::TextureAspect::DepthOnly,
                    ..Default::default()
                });

        self.sky_bg = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("sky_bg"),
            layout: &self.sky_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.equirect_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&depth_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        }));
    }

    /// Record the sky pass into `encoder`.
    ///
    /// Call this **after** the deferred-lighting pass so that sky
    /// fragments (depth == 1.0) are filled with the panorama colour
    /// while geometry fragments are left untouched.
    pub fn record(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        pool: &TexturePool,
        frame_bg: &wgpu::BindGroup,
    ) {
        let sky_bg = match &self.sky_bg {
            Some(bg) => bg,
            None => return,
        };

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("sky_pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: pool.view(handles::HDR),
                resolve_target: None,
                ops: wgpu::Operations {
                    // Preserve lighting output already written
                    // to HDR; sky only overwrites blank pixels.
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });

        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, frame_bg, &[]);
        pass.set_bind_group(1, sky_bg, &[]);
        pass.draw(0..3, 0..1);
    }
}

// ── PNG loader ────────────────────────────────────────

/// Decode a PNG file at `path` into RGBA8 bytes.
/// Falls back to the built-in 4×2 purple gradient on any error.
fn load_png(path: &str) -> (Vec<u8>, u32, u32) {
    use image::ImageDecoder;

    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("sky: cannot read {path}: {e}; using fallback");
            return fallback_rgba();
        }
    };

    let cursor = std::io::Cursor::new(bytes);
    let decoder = match image::codecs::png::PngDecoder::new(cursor) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("sky: PNG decode error: {e}; using fallback");
            return fallback_rgba();
        }
    };

    let (w, h) = decoder.dimensions();
    let total = (w * h * 4) as usize;
    let mut rgba = vec![0u8; total];

    // Convert any colour type to RGBA8.
    let dyn_img = match image::DynamicImage::from_decoder(decoder) {
        Ok(img) => img,
        Err(e) => {
            tracing::warn!("sky: image conversion error: {e}; using fallback");
            return fallback_rgba();
        }
    };
    let img_rgba = dyn_img.to_rgba8();
    rgba.copy_from_slice(img_rgba.as_raw());

    (rgba, w, h)
}
