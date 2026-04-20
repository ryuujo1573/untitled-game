//! Post-processing pass: TAA + ACES tonemap.
//!
//! Full-screen triangle reading the HDR buffer and writing directly to
//! the swapchain surface.

use crate::texture_pool::{handles, TexturePool};
use bytemuck::{Pod, Zeroable};
use wgpu;
use wgpu::util::DeviceExt;

/// GPU uniform for post/tonemap settings.
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct PostUBO {
    pub exposure: f32,
    pub bloom_strength: f32,
    pub taa_blend: f32,
    pub _pad: f32,
}

impl Default for PostUBO {
    fn default() -> Self {
        Self {
            exposure: 1.0,
            bloom_strength: 0.04,
            taa_blend: 0.9,
            _pad: 0.0,
        }
    }
}

// \u2500\u2500 Colour-grading LUT generation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// 32\u00b3 Rgba8Unorm 3-D texture.  Layout: z=blue, y=green, x=red.
// Suppresses warm hues (red/orange/yellow) and boosts cool hues
// (cyan/blue/purple) to complement the ACES filmic curve.

const LUT_SIZE: usize = 32;

fn generate_lut() -> Vec<u8> {
    let n = LUT_SIZE;
    let mut data = Vec::with_capacity(n * n * n * 4);
    for bz in 0..n {
        for gy in 0..n {
            for rx in 0..n {
                let r = rx as f32 / (n - 1) as f32;
                let g = gy as f32 / (n - 1) as f32;
                let b = bz as f32 / (n - 1) as f32;
                let (ro, go, bo) = lut_grade(r, g, b);
                data.push((ro.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
                data.push((go.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
                data.push((bo.clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
                data.push(255u8);
            }
        }
    }
    data
}

fn lut_grade(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let (h, s, l) = rgb_to_hsl(r, g, b);
    let (ds, dl) = if h < 40.0 || h > 330.0 {
        (-0.18 * s, -0.04)
    } else if h < 70.0 {
        (-0.12 * s, -0.02)
    } else if h < 160.0 {
        (-0.06 * s, 0.0)
    } else if h < 220.0 {
        (0.22 * (1.0 - s), 0.03)
    } else if h < 270.0 {
        (0.10 * (1.0 - s), 0.01)
    } else {
        (0.28 * (1.0 - s), 0.04)
    };
    hsl_to_rgb(h, (s + ds).clamp(0.0, 1.0), (l + dl).clamp(0.0, 1.0))
}

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) * 0.5;
    let d = max - min;
    if d < 1e-6 { return (0.0, 0.0, l); }
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if (max - r).abs() < 1e-6 {
        let mut h = (g - b) / d;
        if h < 0.0 { h += 6.0; }
        h * 60.0
    } else if (max - g).abs() < 1e-6 {
        ((b - r) / d + 2.0) * 60.0
    } else {
        ((r - g) / d + 4.0) * 60.0
    };
    (h, s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    if s < 1e-6 { return (l, l, l); }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let hk = h / 360.0;
    (
        hue_to_rgb(p, q, hk + 1.0 / 3.0),
        hue_to_rgb(p, q, hk),
        hue_to_rgb(p, q, hk - 1.0 / 3.0),
    )
}

fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 { t += 1.0; }
    if t > 1.0 { t -= 1.0; }
    if t < 1.0 / 6.0 { return p + (q - p) * 6.0 * t; }
    if t < 0.5 { return q; }
    if t < 2.0 / 3.0 { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
    p
}

/// Pipeline and layouts for the tonemap/TAA pass.
pub struct PostPass {
    pub pipeline:    wgpu::RenderPipeline,
    /// Layout for group 0: HDR + history + motion + sampler + LUT.
    pub hdr_bgl:     wgpu::BindGroupLayout,
    /// Layout for group 1: PostUBO.
    pub post_bgl:    wgpu::BindGroupLayout,
    /// Bind group for group 0 (recreated on resize).
    pub hdr_bg:      Option<wgpu::BindGroup>,
    /// Linear sampler used for HDR lookups.
    pub sampler:     wgpu::Sampler,
    /// Uniform buffer for PostUBO (written each frame).
    pub post_buf:    wgpu::Buffer,
    pub post_bg:     wgpu::BindGroup,
    /// Cached settings.
    pub settings:    PostUBO,
    /// 32³ colour-grading LUT texture (kept alive here).
    pub _lut_tex:    wgpu::Texture,
    pub lut_view:    wgpu::TextureView,
}

impl PostPass {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pool: &TexturePool,
        surface_format: wgpu::TextureFormat,
    ) -> Self {
        let hdr_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("post_hdr_bgl"),
            entries: &[
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
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // binding 4: 3-D colour-grading LUT
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D3,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
            ],
        });

        let post_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("post_bgl"),
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

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("post_layout"),
            bind_group_layouts: &[&hdr_bgl, &post_bgl],
            push_constant_ranges: &[],
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("tonemap"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/tonemap.wgsl").into()),
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("post_pipeline"),
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
                    format: surface_format,
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

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("post_sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let settings = PostUBO::default();
        let post_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("post_ubo"),
            contents: bytemuck::bytes_of(&settings),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let post_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("post_bg"),
            layout: &post_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: post_buf.as_entire_binding(),
            }],
        });

        // ── Colour-grading LUT (32³ Rgba8Unorm 3-D texture) ──────────
        let lut_data = generate_lut();
        let lut_n = LUT_SIZE as u32;
        let lut_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("color_lut"),
            size: wgpu::Extent3d {
                width: lut_n,
                height: lut_n,
                depth_or_array_layers: lut_n,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &lut_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &lut_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * lut_n),
                rows_per_image: Some(lut_n),
            },
            wgpu::Extent3d {
                width: lut_n,
                height: lut_n,
                depth_or_array_layers: lut_n,
            },
        );
        let lut_view = lut_tex.create_view(&Default::default());

        let mut pass = Self {
            pipeline,
            hdr_bgl,
            post_bgl,
            hdr_bg: None,
            sampler,
            post_buf,
            post_bg,
            settings,
            _lut_tex: lut_tex,
            lut_view,
        };
        pass.rebuild_hdr_bg(device, pool);
        pass
    }

    /// Recreate the HDR bind group (called on resize).
    pub fn rebuild_hdr_bg(&mut self, device: &wgpu::Device, pool: &TexturePool) {
        self.hdr_bg = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("post_hdr_bg"),
            layout: &self.hdr_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(
                        pool.view(handles::MOTION_BLUR_HDR),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(pool.view(handles::HISTORY_HDR)),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(pool.view(handles::GBUF_MOTION)),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&self.lut_view),
                },
            ],
        }));
    }

    /// Record the tonemap pass writing to `surface_view`.
    pub fn record(&self, encoder: &mut wgpu::CommandEncoder, surface_view: &wgpu::TextureView) {
        let hdr_bg = self.hdr_bg.as_ref().expect("rebuild_hdr_bg not called");

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("tonemap"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: surface_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });

        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, hdr_bg, &[]);
        pass.set_bind_group(1, &self.post_bg, &[]);
        pass.draw(0..3, 0..1);
    }
}
