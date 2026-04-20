use std::collections::HashMap;
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;
use winit::window::Window;

use crate::renderer::types::{ChunkMeshData, FrameState};

// ── GPU-side uniform structs ───────────────────────────

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct FrameUniforms {
    pub view_proj: [f32; 16], // offset   0 — 64 B
    pub sun_dir: [f32; 3],    // offset  64 — 12 B
    pub _pad: f32,            // offset  76 —  4 B
    pub view: [f32; 16],      // offset  80 — 64 B
    pub proj: [f32; 16],      // offset 144 — 64 B
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct ChunkUniforms {
    pub model: [[f32; 4]; 4],
}

// ── Per-chunk GPU buffers ──────────────────────────────

pub struct ChunkGPU {
    pub pos_buf: wgpu::Buffer,
    pub normal_buf: wgpu::Buffer,
    pub uvl_buf: wgpu::Buffer,
    pub light_buf: wgpu::Buffer,
    pub vertex_count: u32,
    pub uniform_buf: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
}

// ── Core GPU context ───────────────────────────────────

pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
    pub depth_view: wgpu::TextureView,
    pub pipeline: wgpu::RenderPipeline,
    pub frame_uniform_buf: wgpu::Buffer,
    pub frame_bind_group: wgpu::BindGroup,
    pub chunk_bgl: wgpu::BindGroupLayout,
    pub chunks: HashMap<(i32, i32), ChunkGPU>,
    /// Block selection outline (LineList, 3-D).
    pub outline_pipeline: wgpu::RenderPipeline,
    /// 24 vertices × 3 floats = 288 bytes, COPY_DST.
    pub outline_buf: wgpu::Buffer,
    /// Screen-space crosshair (TriangleList, 2-D).
    pub crosshair_pipeline: wgpu::RenderPipeline,
    /// Static 12-vertex buffer for the + shape.
    pub crosshair_buf: wgpu::Buffer,
    /// egui paint renderer.
    pub egui_renderer: egui_wgpu::Renderer,
    /// Max texture side reported by the adapter.
    pub max_texture_side: usize,
    /// Equirectangular sky pipeline.
    pub sky_pipeline: wgpu::RenderPipeline,
    /// Sky bind group (equirect texture + sampler).
    pub sky_bg: wgpu::BindGroup,
    /// Keep the sky texture alive.
    pub _sky_tex: wgpu::Texture,
    /// Intermediate scene render target (Rgba8Unorm, same size as swapchain).
    pub scene_tex: wgpu::Texture,
    pub scene_view: wgpu::TextureView,
    /// 3-D colour-grading LUT pipeline (scene_tex → swapchain).
    pub lut_pipeline: wgpu::RenderPipeline,
    /// Bind group: scene_tex + lut_tex + sampler.
    pub lut_bg: wgpu::BindGroup,
    /// Stored so resize() can rebuild lut_bg.
    pub lut_bgl: wgpu::BindGroupLayout,
    pub lut_sampler: wgpu::Sampler,
    /// Keep the LUT texture alive.
    pub _lut_tex: wgpu::Texture,
}

// ── Colour-grading LUT generation ─────────────────────
//
// 32×32×32 Rgba8Unorm 3-D texture.
// Layout: z = blue index (0..32), y = green, x = red.
// Colour grading: suppress warm (red/orange/yellow),
//                 boost cool (cyan / purple).

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

/// Apply the colour-grade transform for a single (r,g,b) ∈ [0,1].
fn lut_grade(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let (h, s, l) = rgb_to_hsl(r, g, b);
    // Per-hue-range saturation / lightness deltas.
    let (ds, dl) = if h < 40.0 || h > 330.0 {
        // Warm reds / oranges — pull back.
        (-0.18 * s, -0.04)
    } else if h < 70.0 {
        // Yellows — slight pull back.
        (-0.12 * s, -0.02)
    } else if h < 160.0 {
        // Greens — mild desaturate.
        (-0.06 * s, 0.0)
    } else if h < 220.0 {
        // Cyans — boost.
        (0.22 * (1.0 - s), 0.03)
    } else if h < 270.0 {
        // Blues — slight boost.
        (0.10 * (1.0 - s), 0.01)
    } else {
        // Purples / violets — strong boost.
        (0.28 * (1.0 - s), 0.04)
    };
    hsl_to_rgb(h, (s + ds).clamp(0.0, 1.0), (l + dl).clamp(0.0, 1.0))
}

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) * 0.5;
    let d = max - min;
    if d < 1e-6 {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if (max - r).abs() < 1e-6 {
        let mut h = (g - b) / d;
        if h < 0.0 {
            h += 6.0;
        }
        h * 60.0
    } else if (max - g).abs() < 1e-6 {
        ((b - r) / d + 2.0) * 60.0
    } else {
        ((r - g) / d + 4.0) * 60.0
    };
    (h, s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    if s < 1e-6 {
        return (l, l, l);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let hk = h / 360.0;
    (
        hue_to_rgb(p, q, hk + 1.0 / 3.0),
        hue_to_rgb(p, q, hk),
        hue_to_rgb(p, q, hk - 1.0 / 3.0),
    )
}

fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 0.5 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    p
}

// ── Sky PNG loader ─────────────────────────────────────

fn load_sky_png(path: &str) -> (Vec<u8>, u32, u32) {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("sky: cannot read {path}: {e}; using fallback");
            return fallback_sky();
        }
    };
    let cursor = std::io::Cursor::new(bytes);
    let decoder = match image::codecs::png::PngDecoder::new(cursor) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("sky: PNG decode error: {e}; using fallback");
            return fallback_sky();
        }
    };
    let dyn_img = match image::DynamicImage::from_decoder(decoder) {
        Ok(img) => img,
        Err(e) => {
            log::warn!("sky: image error: {e}; using fallback");
            return fallback_sky();
        }
    };
    let img = dyn_img.to_rgba8();
    let (w, h) = img.dimensions();
    (img.into_raw(), w, h)
}

fn fallback_sky() -> (Vec<u8>, u32, u32) {
    // 4×2 deep-purple gradient used when void.png is missing.
    #[rustfmt::skip]
    let pixels: Vec<u8> = vec![
        20, 10, 40, 255,  30, 15, 60, 255,  25, 12, 50, 255,  35, 18, 70, 255,
         5,  2, 10, 255,   8,  4, 16, 255,   6,  3, 12, 255,  10,  5, 20, 255,
    ];
    (pixels, 4, 2)
}

// ── GpuContext ─────────────────────────────────────────

impl GpuContext {
    /// Create a GPU context from a winit window.
    /// The `Arc<Window>` must outlive the GpuContext.
    pub fn from_window(window: Arc<Window>) -> Self {
        pollster::block_on(Self::init(window))
    }

    async fn init(window: Arc<Window>) -> Self {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::METAL | wgpu::Backends::DX12,
            ..Default::default()
        });

        // Safe: Arc<Window> is 'static + implements
        // HasWindowHandle + HasDisplayHandle.
        let surface = instance
            .create_surface(window.clone())
            .expect("failed to create wgpu surface");

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("no compatible GPU adapter");

        log::info!("wgpu adapter: {:?}", adapter.get_info());

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("voidborne-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::default(),
                },
                None,
            )
            .await
            .expect("failed to create wgpu device");

        let size = window.inner_size();
        let caps = surface.get_capabilities(&adapter);

        let format = caps
            .formats
            .iter()
            .find(|f| {
                matches!(
                    f,
                    wgpu::TextureFormat::Rgba8UnormSrgb
                        | wgpu::TextureFormat::Bgra8UnormSrgb
                        | wgpu::TextureFormat::Rgba8Unorm
                        | wgpu::TextureFormat::Bgra8Unorm
                )
            })
            .copied()
            .unwrap_or(caps.formats[0]);

        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes[0]
        };

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let depth_view = Self::create_depth_view(&device, &config);

        // ── Bind group layouts ─────────────────────
        let frame_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("frame_bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let chunk_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("chunk_bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let frame_uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("frame_ubo"),
            size: std::mem::size_of::<FrameUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("frame_bg"),
            layout: &frame_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: frame_uniform_buf.as_entire_binding(),
            }],
        });

        // ── Sky equirectangular pipeline ─────────
        let sky_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sky_bgl"),
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
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let (sky_rgba, sky_w, sky_h) = load_sky_png("assets/skybox/void.png");

        let sky_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("sky_equirect"),
            size: wgpu::Extent3d {
                width: sky_w,
                height: sky_h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // sRGB format: GPU converts sRGB→linear on sample.
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &sky_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &sky_rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * sky_w),
                rows_per_image: Some(sky_h),
            },
            wgpu::Extent3d {
                width: sky_w,
                height: sky_h,
                depth_or_array_layers: 1,
            },
        );
        let sky_tex_view = sky_tex.create_view(&Default::default());

        let sky_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("sky_sampler"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let sky_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("sky_bg"),
            layout: &sky_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&sky_tex_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sky_sampler),
                },
            ],
        });

        let sky_pl_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("sky_pl"),
            bind_group_layouts: &[&frame_bgl, &sky_bgl],
            push_constant_ranges: &[],
        });

        let sky_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("sky_equirect"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/sky_equirect.wgsl").into()),
        });

        let sky_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("sky_pipeline"),
            layout: Some(&sky_pl_layout),
            vertex: wgpu::VertexState {
                module: &sky_shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &sky_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        // ── Intermediate scene render target ─────
        // All scene passes (sky / voxels / crosshair) render to this
        // Rgba8Unorm texture; the LUT blit pass then resolves it to the
        // swapchain with colour-grading applied.
        let scene_tex = Self::create_scene_tex(&device, &config);
        let scene_view = scene_tex.create_view(&Default::default());

        // ── Colour-grading LUT ────────────────────
        // 32×32×32  Rgba8Unorm  3-D texture, generated at startup.
        let lut_n = LUT_SIZE as u32;
        let lut_data = generate_lut();
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
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
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
        let lut_tex_view = lut_tex.create_view(&Default::default());

        let lut_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("lut_sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let lut_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("lut_bgl"),
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
                        view_dimension: wgpu::TextureViewDimension::D3,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let lut_bg =
            Self::create_lut_bg(&device, &lut_bgl, &scene_view, &lut_tex_view, &lut_sampler);

        let lut_pl_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("lut_pl"),
            bind_group_layouts: &[&lut_bgl],
            push_constant_ranges: &[],
        });

        let lut_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("lut_blit"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/lut_blit.wgsl").into()),
        });

        // The LUT blit outputs directly to the swapchain format.
        let lut_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("lut_pipeline"),
            layout: Some(&lut_pl_layout),
            vertex: wgpu::VertexState {
                module: &lut_shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &lut_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        // ── Voxel pipeline ───────────────────────
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("voxel_forward"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/voxel_forward.wgsl").into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("voxel_pl"),
            bind_group_layouts: &[&frame_bgl, &chunk_bgl],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("voxel_forward"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[
                    wgpu::VertexBufferLayout {
                        array_stride: 12,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: 0,
                            shader_location: 0,
                        }],
                    },
                    wgpu::VertexBufferLayout {
                        array_stride: 12,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: 0,
                            shader_location: 1,
                        }],
                    },
                    wgpu::VertexBufferLayout {
                        array_stride: 16,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x4,
                            offset: 0,
                            shader_location: 2,
                        }],
                    },
                    wgpu::VertexBufferLayout {
                        array_stride: 8,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 0,
                            shader_location: 3,
                        }],
                    },
                ],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        // ── Outline pipeline (LineList, 3-D) ──────

        let outline_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("outline"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/outline.wgsl").into()),
        });

        let outline_pl_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("outline_pl"),
            bind_group_layouts: &[&frame_bgl],
            push_constant_ranges: &[],
        });

        let outline_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("outline"),
            layout: Some(&outline_pl_layout),
            vertex: wgpu::VertexState {
                module: &outline_shader,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: 12,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Float32x3,
                        offset: 0,
                        shader_location: 0,
                    }],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &outline_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        // 24 vertices × 3 floats — written each frame
        let outline_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("outline_buf"),
            size: (24 * 3 * 4) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // ── Crosshair pipeline (2-D overlay) ──────

        let crosshair_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("crosshair"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/crosshair.wgsl").into()),
        });

        let crosshair_pl_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("crosshair_pl"),
            bind_group_layouts: &[],
            push_constant_ranges: &[],
        });

        let crosshair_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("crosshair"),
            layout: Some(&crosshair_pl_layout),
            vertex: wgpu::VertexState {
                module: &crosshair_shader,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: 8,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Float32x2,
                        offset: 0,
                        shader_location: 0,
                    }],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &crosshair_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent::OVER,
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        // Two axis-aligned quads: horizontal + vertical.
        // NDC coords — acceptable approximation for any
        // common aspect ratio.
        #[rustfmt::skip]
        let cx_verts: [f32; 24] = [
            // horizontal bar
            -0.025, -0.003,  0.025, -0.003,  0.025,  0.003,
            -0.025, -0.003,  0.025,  0.003, -0.025,  0.003,
            // vertical bar
            -0.003, -0.025,  0.003, -0.025,  0.003,  0.025,
            -0.003, -0.025,  0.003,  0.025, -0.003,  0.025,
        ];
        let crosshair_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("crosshair_buf"),
            contents: bytemuck::cast_slice(&cx_verts),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let max_texture_side = device.limits().max_texture_dimension_2d as usize;

        let egui_renderer = egui_wgpu::Renderer::new(&device, format, None, 1, false);

        Self {
            device,
            queue,
            surface,
            config,
            depth_view,
            pipeline,
            frame_uniform_buf,
            frame_bind_group,
            chunk_bgl,
            chunks: HashMap::new(),
            outline_pipeline,
            outline_buf,
            crosshair_pipeline,
            crosshair_buf,
            egui_renderer,
            max_texture_side,
            sky_pipeline,
            sky_bg,
            _sky_tex: sky_tex,
            scene_tex,
            scene_view,
            lut_pipeline,
            lut_bg,
            lut_bgl,
            lut_sampler,
            _lut_tex: lut_tex,
        }
    }

    fn create_depth_view(
        device: &wgpu::Device,
        config: &wgpu::SurfaceConfiguration,
    ) -> wgpu::TextureView {
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("depth"),
            size: wgpu::Extent3d {
                width: config.width,
                height: config.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth24Plus,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        tex.create_view(&Default::default())
    }

    fn create_scene_tex(
        device: &wgpu::Device,
        config: &wgpu::SurfaceConfiguration,
    ) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("scene_rt"),
            size: wgpu::Extent3d {
                width: config.width.max(1),
                height: config.height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // Always Rgba8Unorm so all scene pipelines target a stable format
            // regardless of the swapchain format.
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    }

    fn create_lut_bg(
        device: &wgpu::Device,
        lut_bgl: &wgpu::BindGroupLayout,
        scene_view: &wgpu::TextureView,
        lut_tex_view: &wgpu::TextureView,
        lut_sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lut_bg"),
            layout: lut_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(scene_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(lut_tex_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(lut_sampler),
                },
            ],
        })
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
        self.depth_view = Self::create_depth_view(&self.device, &self.config);
        // Recreate scene render target at the new size.
        self.scene_tex = Self::create_scene_tex(&self.device, &self.config);
        self.scene_view = self.scene_tex.create_view(&Default::default());
        // Rebuild lut_bg to point at the new scene_view.
        let lut_tex_view = self._lut_tex.create_view(&Default::default());
        self.lut_bg = Self::create_lut_bg(
            &self.device,
            &self.lut_bgl,
            &self.scene_view,
            &lut_tex_view,
            &self.lut_sampler,
        );
    }

    /// Change the swapchain present mode (V-Sync on/off) without a full resize.
    pub fn set_present_mode(&mut self, mode: wgpu::PresentMode) {
        self.config.present_mode = mode;
        self.surface.configure(&self.device, &self.config);
    }

    /// Upload / free egui textures.  Call this when a new EguiFrame arrives,
    /// before the next render.  Does not need an encoder.
    pub fn apply_egui_textures(&mut self, delta: &egui::TexturesDelta) {
        for (id, image_delta) in &delta.set {
            self.egui_renderer
                .update_texture(&self.device, &self.queue, *id, image_delta);
        }
        for id in &delta.free {
            self.egui_renderer.free_texture(id);
        }
    }

    // ── Chunk management ───────────────────────────

    pub fn load_chunk(&mut self, data: ChunkMeshData) {
        if data.vertex_count == 0 {
            self.chunks.remove(&(data.cx, data.cz));
            return;
        }

        let pos_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("chunk_pos"),
                contents: bytemuck::cast_slice(&data.positions),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let normal_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("chunk_normal"),
                contents: bytemuck::cast_slice(&data.normals),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let uvl_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("chunk_uvl"),
                contents: bytemuck::cast_slice(&data.uvls),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let light_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("chunk_light"),
                contents: bytemuck::cast_slice(&data.lights),
                usage: wgpu::BufferUsages::VERTEX,
            });

        let tx = (data.cx * 16) as f32;
        let tz = (data.cz * 16) as f32;
        let model = ChunkUniforms {
            model: [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [tx, 0.0, tz, 1.0],
            ],
        };

        let uniform_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("chunk_ubo"),
                contents: bytemuck::bytes_of(&model),
                usage: wgpu::BufferUsages::UNIFORM,
            });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("chunk_bg"),
            layout: &self.chunk_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buf.as_entire_binding(),
            }],
        });

        self.chunks.insert(
            (data.cx, data.cz),
            ChunkGPU {
                pos_buf,
                normal_buf,
                uvl_buf,
                light_buf,
                vertex_count: data.vertex_count,
                uniform_buf,
                bind_group,
            },
        );
    }

    pub fn unload_chunk(&mut self, cx: i32, cz: i32) {
        self.chunks.remove(&(cx, cz));
    }

    // ── Render ─────────────────────────────────────

    pub fn render(
        &mut self,
        state: &FrameState,
        egui: Option<(&[egui::ClippedPrimitive], &egui_wgpu::ScreenDescriptor)>,
    ) {
        let cam = &state.camera;
        let vp = mat4_mul_col(&cam.projection_matrix, &cam.view_matrix);
        let uniforms = FrameUniforms {
            view_proj: vp,
            sun_dir: state.sun_direction,
            _pad: 0.0,
            view: cam.view_matrix,
            proj: cam.projection_matrix,
        };
        self.queue
            .write_buffer(&self.frame_uniform_buf, 0, bytemuck::bytes_of(&uniforms));

        let output = match self.surface.get_current_texture() {
            Ok(t) => t,
            Err(wgpu::SurfaceError::Lost) => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            Err(e) => {
                log::error!("surface error: {e:?}");
                return;
            }
        };
        let view = output.texture.create_view(&Default::default());

        let mut encoder = self.device.create_command_encoder(&Default::default());

        // ── Sky background → scene_tex ────────────────
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("sky"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.scene_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
            pass.set_pipeline(&self.sky_pipeline);
            pass.set_bind_group(0, &self.frame_bind_group, &[]);
            pass.set_bind_group(1, &self.sky_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        // ── Voxel geometry + outline → scene_tex ──────
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("voxel"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.scene_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // Sky already drew the background.
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });

            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.frame_bind_group, &[]);

            for chunk in self.chunks.values() {
                pass.set_bind_group(1, &chunk.bind_group, &[]);
                pass.set_vertex_buffer(0, chunk.pos_buf.slice(..));
                pass.set_vertex_buffer(1, chunk.normal_buf.slice(..));
                pass.set_vertex_buffer(2, chunk.uvl_buf.slice(..));
                pass.set_vertex_buffer(3, chunk.light_buf.slice(..));
                pass.draw(0..chunk.vertex_count, 0..1);
            }

            // Block selection outline.
            if let Some([bx, by, bz]) = state.targeted_block {
                let verts = build_outline_verts(bx, by, bz);
                self.queue
                    .write_buffer(&self.outline_buf, 0, bytemuck::cast_slice(&verts));
                pass.set_pipeline(&self.outline_pipeline);
                pass.set_bind_group(0, &self.frame_bind_group, &[]);
                pass.set_vertex_buffer(0, self.outline_buf.slice(..));
                pass.draw(0..24, 0..1);
            }
        }

        // 2-D crosshair overlay → scene_tex (no depth).
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("crosshair"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.scene_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
            pass.set_pipeline(&self.crosshair_pipeline);
            pass.set_vertex_buffer(0, self.crosshair_buf.slice(..));
            pass.draw(0..12, 0..1);
        }

        // ── LUT blit: scene_tex → swapchain ──────────
        // Applies the 3-D colour-grading LUT; egui renders on top of this.
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("lut_blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
            pass.set_pipeline(&self.lut_pipeline);
            pass.set_bind_group(0, &self.lut_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        if let Some((primitives, screen_descriptor)) = egui {
            let mut extra = self.egui_renderer.update_buffers(
                &self.device,
                &self.queue,
                &mut encoder,
                primitives,
                screen_descriptor,
            );
            {
                let mut rpass = encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("egui"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &view,
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
                    .render(&mut rpass, primitives, screen_descriptor);
            }
            extra.push(encoder.finish());
            self.queue.submit(extra);
        } else {
            self.queue.submit(std::iter::once(encoder.finish()));
        }
        output.present();
    }
}

// ── Matrix helpers (column-major) ─────────────────────

fn mat4_mul_col(a: &[f32; 16], b: &[f32; 16]) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for col in 0..4 {
        for row in 0..4 {
            out[col * 4 + row] = a[row] * b[col * 4]
                + a[4 + row] * b[col * 4 + 1]
                + a[8 + row] * b[col * 4 + 2]
                + a[12 + row] * b[col * 4 + 3];
        }
    }
    out
}

// ── Block outline geometry ─────────────────────────────

/// Build 24 line-list vertices (12 edges × 2 endpoints)
/// for a selection cube around the block at (bx,by,bz).
#[rustfmt::skip]
fn build_outline_verts(
    bx: i32,
    by: i32,
    bz: i32,
) -> [f32; 72] {
    let e = 0.002_f32;
    let x0 = bx as f32 - e;
    let y0 = by as f32 - e;
    let z0 = bz as f32 - e;
    let x1 = bx as f32 + 1.0 + e;
    let y1 = by as f32 + 1.0 + e;
    let z1 = bz as f32 + 1.0 + e;
    [
        // bottom face
        x0,y0,z0,  x1,y0,z0,
        x1,y0,z0,  x1,y0,z1,
        x1,y0,z1,  x0,y0,z1,
        x0,y0,z1,  x0,y0,z0,
        // top face
        x0,y1,z0,  x1,y1,z0,
        x1,y1,z0,  x1,y1,z1,
        x1,y1,z1,  x0,y1,z1,
        x0,y1,z1,  x0,y1,z0,
        // vertical edges
        x0,y0,z0,  x0,y1,z0,
        x1,y0,z0,  x1,y1,z0,
        x1,y0,z1,  x1,y1,z1,
        x0,y0,z1,  x0,y1,z1,
    ]
}
