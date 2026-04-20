use std::collections::HashMap;
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;
use winit::window::Window;

use crate::renderer::types::{
    ChunkMeshData, EguiFrame, FrameState,
};

// ── GPU-side uniform structs ───────────────────────────

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct FrameUniforms {
    pub view_proj: [f32; 16],
    pub sun_dir: [f32; 3],
    pub _pad: f32,
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
}

impl GpuContext {
    /// Create a GPU context from a winit window.
    /// The `Arc<Window>` must outlive the GpuContext.
    pub fn from_window(window: Arc<Window>) -> Self {
        pollster::block_on(Self::init(window))
    }

    async fn init(window: Arc<Window>) -> Self {
        let instance =
            wgpu::Instance::new(&wgpu::InstanceDescriptor {
                backends: wgpu::Backends::VULKAN
                    | wgpu::Backends::METAL
                    | wgpu::Backends::DX12,
                ..Default::default()
            });

        // Safe: Arc<Window> is 'static + implements
        // HasWindowHandle + HasDisplayHandle.
        let surface = instance
            .create_surface(window.clone())
            .expect("failed to create wgpu surface");

        let adapter = instance
            .request_adapter(
                &wgpu::RequestAdapterOptions {
                    power_preference:
                        wgpu::PowerPreference::HighPerformance,
                    compatible_surface: Some(&surface),
                    force_fallback_adapter: false,
                },
            )
            .await
            .expect("no compatible GPU adapter");

        log::info!(
            "wgpu adapter: {:?}",
            adapter.get_info()
        );

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("voidborne-device"),
                    required_features:
                        wgpu::Features::empty(),
                    required_limits:
                        wgpu::Limits::default(),
                    memory_hints:
                        wgpu::MemoryHints::default(),
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

        let alpha_mode = if caps
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::Opaque)
        {
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

        let depth_view =
            Self::create_depth_view(&device, &config);

        // ── Bind group layouts ─────────────────────
        let frame_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("frame_bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility:
                        wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            },
        );

        let chunk_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
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
            },
        );

        let frame_uniform_buf = device.create_buffer(
            &wgpu::BufferDescriptor {
                label: Some("frame_ubo"),
                size: std::mem::size_of::<FrameUniforms>()
                    as u64,
                usage: wgpu::BufferUsages::UNIFORM
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            },
        );

        let frame_bind_group =
            device.create_bind_group(
                &wgpu::BindGroupDescriptor {
                    label: Some("frame_bg"),
                    layout: &frame_bgl,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: frame_uniform_buf
                            .as_entire_binding(),
                    }],
                },
            );

        // ── Pipeline ───────────────────────────────
        let shader =
            device.create_shader_module(
                wgpu::ShaderModuleDescriptor {
                    label: Some("voxel_forward"),
                    source: wgpu::ShaderSource::Wgsl(
                        include_str!(
                            "../shaders/voxel_forward.wgsl"
                        )
                        .into(),
                    ),
                },
            );

        let pipeline_layout = device
            .create_pipeline_layout(
                &wgpu::PipelineLayoutDescriptor {
                    label: Some("voxel_pl"),
                    bind_group_layouts: &[
                        &frame_bgl,
                        &chunk_bgl,
                    ],
                    push_constant_ranges: &[],
                },
            );

        let pipeline = device.create_render_pipeline(
            &wgpu::RenderPipelineDescriptor {
                label: Some("voxel_forward"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[
                        wgpu::VertexBufferLayout {
                            array_stride: 12,
                            step_mode:
                                wgpu::VertexStepMode::Vertex,
                            attributes: &[
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x3,
                                    offset: 0,
                                    shader_location: 0,
                                },
                            ],
                        },
                        wgpu::VertexBufferLayout {
                            array_stride: 12,
                            step_mode:
                                wgpu::VertexStepMode::Vertex,
                            attributes: &[
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x3,
                                    offset: 0,
                                    shader_location: 1,
                                },
                            ],
                        },
                        wgpu::VertexBufferLayout {
                            array_stride: 16,
                            step_mode:
                                wgpu::VertexStepMode::Vertex,
                            attributes: &[
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: 0,
                                    shader_location: 2,
                                },
                            ],
                        },
                        wgpu::VertexBufferLayout {
                            array_stride: 8,
                            step_mode:
                                wgpu::VertexStepMode::Vertex,
                            attributes: &[
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x2,
                                    offset: 0,
                                    shader_location: 3,
                                },
                            ],
                        },
                    ],
                    compilation_options:
                        Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(
                        wgpu::ColorTargetState {
                            format,
                            blend: Some(
                                wgpu::BlendState::REPLACE,
                            ),
                            write_mask:
                                wgpu::ColorWrites::ALL,
                        },
                    )],
                    compilation_options:
                        Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology:
                        wgpu::PrimitiveTopology::TriangleList,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode: Some(wgpu::Face::Back),
                    ..Default::default()
                },
                depth_stencil: Some(
                    wgpu::DepthStencilState {
                        format:
                            wgpu::TextureFormat::Depth24Plus,
                        depth_write_enabled: true,
                        depth_compare:
                            wgpu::CompareFunction::Less,
                        stencil: Default::default(),
                        bias: Default::default(),
                    },
                ),
                multisample: Default::default(),
                multiview: None,
                cache: None,
            },
        );

        // ── Outline pipeline (LineList, 3-D) ──────

        let outline_shader = device
            .create_shader_module(
                wgpu::ShaderModuleDescriptor {
                    label: Some("outline"),
                    source: wgpu::ShaderSource::Wgsl(
                        include_str!(
                            "../shaders/outline.wgsl"
                        )
                        .into(),
                    ),
                },
            );

        let outline_pl_layout = device
            .create_pipeline_layout(
                &wgpu::PipelineLayoutDescriptor {
                    label: Some("outline_pl"),
                    bind_group_layouts: &[&frame_bgl],
                    push_constant_ranges: &[],
                },
            );

        let outline_pipeline = device
            .create_render_pipeline(
                &wgpu::RenderPipelineDescriptor {
                    label: Some("outline"),
                    layout: Some(&outline_pl_layout),
                    vertex: wgpu::VertexState {
                        module: &outline_shader,
                        entry_point: Some("vs_main"),
                        buffers: &[
                            wgpu::VertexBufferLayout {
                                array_stride: 12,
                                step_mode: wgpu::VertexStepMode::Vertex,
                                attributes: &[
                                    wgpu::VertexAttribute {
                                        format: wgpu::VertexFormat::Float32x3,
                                        offset: 0,
                                        shader_location: 0,
                                    },
                                ],
                            },
                        ],
                        compilation_options:
                            Default::default(),
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &outline_shader,
                        entry_point: Some("fs_main"),
                        targets: &[Some(
                            wgpu::ColorTargetState {
                                format,
                                blend: Some(
                                    wgpu::BlendState::REPLACE,
                                ),
                                write_mask:
                                    wgpu::ColorWrites::ALL,
                            },
                        )],
                        compilation_options:
                            Default::default(),
                    }),
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::LineList,
                        ..Default::default()
                    },
                    depth_stencil: Some(
                        wgpu::DepthStencilState {
                            format: wgpu::TextureFormat::Depth24Plus,
                            depth_write_enabled: false,
                            depth_compare: wgpu::CompareFunction::LessEqual,
                            stencil: Default::default(),
                            bias: Default::default(),
                        },
                    ),
                    multisample: Default::default(),
                    multiview: None,
                    cache: None,
                },
            );

        // 24 vertices × 3 floats — written each frame
        let outline_buf = device.create_buffer(
            &wgpu::BufferDescriptor {
                label: Some("outline_buf"),
                size: (24 * 3 * 4) as u64,
                usage: wgpu::BufferUsages::VERTEX
                    | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            },
        );

        // ── Crosshair pipeline (2-D overlay) ──────

        let crosshair_shader = device
            .create_shader_module(
                wgpu::ShaderModuleDescriptor {
                    label: Some("crosshair"),
                    source: wgpu::ShaderSource::Wgsl(
                        include_str!(
                            "../shaders/crosshair.wgsl"
                        )
                        .into(),
                    ),
                },
            );

        let crosshair_pl_layout = device
            .create_pipeline_layout(
                &wgpu::PipelineLayoutDescriptor {
                    label: Some("crosshair_pl"),
                    bind_group_layouts: &[],
                    push_constant_ranges: &[],
                },
            );

        let crosshair_pipeline = device
            .create_render_pipeline(
                &wgpu::RenderPipelineDescriptor {
                    label: Some("crosshair"),
                    layout: Some(&crosshair_pl_layout),
                    vertex: wgpu::VertexState {
                        module: &crosshair_shader,
                        entry_point: Some("vs_main"),
                        buffers: &[
                            wgpu::VertexBufferLayout {
                                array_stride: 8,
                                step_mode: wgpu::VertexStepMode::Vertex,
                                attributes: &[
                                    wgpu::VertexAttribute {
                                        format: wgpu::VertexFormat::Float32x2,
                                        offset: 0,
                                        shader_location: 0,
                                    },
                                ],
                            },
                        ],
                        compilation_options:
                            Default::default(),
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &crosshair_shader,
                        entry_point: Some("fs_main"),
                        targets: &[Some(
                            wgpu::ColorTargetState {
                                format,
                                blend: Some(wgpu::BlendState {
                                    color: wgpu::BlendComponent {
                                        src_factor: wgpu::BlendFactor::SrcAlpha,
                                        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                                        operation: wgpu::BlendOperation::Add,
                                    },
                                    alpha: wgpu::BlendComponent::OVER,
                                }),
                                write_mask:
                                    wgpu::ColorWrites::ALL,
                            },
                        )],
                        compilation_options:
                            Default::default(),
                    }),
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleList,
                        ..Default::default()
                    },
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview: None,
                    cache: None,
                },
            );

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
        let crosshair_buf = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("crosshair_buf"),
                contents: bytemuck::cast_slice(&cx_verts),
                usage: wgpu::BufferUsages::VERTEX,
            },
        );

        let max_texture_side = device
            .limits()
            .max_texture_dimension_2d as usize;

        let egui_renderer = egui_wgpu::Renderer::new(
            &device,
            format,
            None,
            1,
            false,
        );

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
        }
    }

    fn create_depth_view(
        device: &wgpu::Device,
        config: &wgpu::SurfaceConfiguration,
    ) -> wgpu::TextureView {
        let tex = device.create_texture(
            &wgpu::TextureDescriptor {
                label: Some("depth"),
                size: wgpu::Extent3d {
                    width: config.width,
                    height: config.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format:
                    wgpu::TextureFormat::Depth24Plus,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            },
        );
        tex.create_view(&Default::default())
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface
            .configure(&self.device, &self.config);
        self.depth_view = Self::create_depth_view(
            &self.device,
            &self.config,
        );
    }

    // ── Chunk management ───────────────────────────

    pub fn load_chunk(&mut self, data: ChunkMeshData) {
        if data.vertex_count == 0 {
            self.chunks.remove(&(data.cx, data.cz));
            return;
        }

        let pos_buf = self.device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("chunk_pos"),
                contents: bytemuck::cast_slice(
                    &data.positions,
                ),
                usage: wgpu::BufferUsages::VERTEX,
            },
        );
        let normal_buf = self.device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("chunk_normal"),
                contents: bytemuck::cast_slice(
                    &data.normals,
                ),
                usage: wgpu::BufferUsages::VERTEX,
            },
        );
        let uvl_buf = self.device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("chunk_uvl"),
                contents: bytemuck::cast_slice(
                    &data.uvls,
                ),
                usage: wgpu::BufferUsages::VERTEX,
            },
        );
        let light_buf = self.device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("chunk_light"),
                contents: bytemuck::cast_slice(
                    &data.lights,
                ),
                usage: wgpu::BufferUsages::VERTEX,
            },
        );

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

        let uniform_buf = self.device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("chunk_ubo"),
                contents: bytemuck::bytes_of(&model),
                usage: wgpu::BufferUsages::UNIFORM,
            },
        );

        let bind_group =
            self.device.create_bind_group(
                &wgpu::BindGroupDescriptor {
                    label: Some("chunk_bg"),
                    layout: &self.chunk_bgl,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniform_buf
                            .as_entire_binding(),
                    }],
                },
            );

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
        egui_frame: Option<EguiFrame>,
    ) {
        let cam = &state.camera;
        let vp = mat4_mul_col(
            &cam.projection_matrix,
            &cam.view_matrix,
        );
        let uniforms = FrameUniforms {
            view_proj: vp,
            sun_dir: state.sun_direction,
            _pad: 0.0,
        };
        self.queue.write_buffer(
            &self.frame_uniform_buf,
            0,
            bytemuck::bytes_of(&uniforms),
        );

        let output =
            match self.surface.get_current_texture() {
                Ok(t) => t,
                Err(wgpu::SurfaceError::Lost) => {
                    self.surface.configure(
                        &self.device,
                        &self.config,
                    );
                    return;
                }
                Err(e) => {
                    log::error!(
                        "surface error: {e:?}"
                    );
                    return;
                }
            };
        let view = output
            .texture
            .create_view(&Default::default());

        let mut encoder = self
            .device
            .create_command_encoder(&Default::default());

        {
            let mut pass = encoder.begin_render_pass(
                &wgpu::RenderPassDescriptor {
                    label: Some("voxel"),
                    color_attachments: &[Some(
                        wgpu::RenderPassColorAttachment {
                            view: &view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(
                                    wgpu::Color {
                                        r: 0.53,
                                        g: 0.81,
                                        b: 0.98,
                                        a: 1.0,
                                    },
                                ),
                                store: wgpu::StoreOp::Store,
                            },
                        },
                    )],
                    depth_stencil_attachment: Some(
                        wgpu::RenderPassDepthStencilAttachment {
                            view: &self.depth_view,
                            depth_ops: Some(wgpu::Operations {
                                load: wgpu::LoadOp::Clear(1.0),
                                store: wgpu::StoreOp::Store,
                            }),
                            stencil_ops: None,
                        },
                    ),
                    ..Default::default()
                },
            );

            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(
                0,
                &self.frame_bind_group,
                &[],
            );

            for chunk in self.chunks.values() {
                pass.set_bind_group(
                    1,
                    &chunk.bind_group,
                    &[],
                );
                pass.set_vertex_buffer(
                    0,
                    chunk.pos_buf.slice(..),
                );
                pass.set_vertex_buffer(
                    1,
                    chunk.normal_buf.slice(..),
                );
                pass.set_vertex_buffer(
                    2,
                    chunk.uvl_buf.slice(..),
                );
                pass.set_vertex_buffer(
                    3,
                    chunk.light_buf.slice(..),
                );
                pass.draw(0..chunk.vertex_count, 0..1);
            }

            // Block selection outline.
            if let Some([bx, by, bz]) =
                state.targeted_block
            {
                let verts =
                    build_outline_verts(bx, by, bz);
                self.queue.write_buffer(
                    &self.outline_buf,
                    0,
                    bytemuck::cast_slice(&verts),
                );
                pass.set_pipeline(&self.outline_pipeline);
                pass.set_bind_group(
                    0,
                    &self.frame_bind_group,
                    &[],
                );
                pass.set_vertex_buffer(
                    0,
                    self.outline_buf.slice(..),
                );
                pass.draw(0..24, 0..1);
            }
        }

        // 2-D crosshair overlay (no depth).
        {
            let mut pass = encoder.begin_render_pass(
                &wgpu::RenderPassDescriptor {
                    label: Some("crosshair"),
                    color_attachments: &[Some(
                        wgpu::RenderPassColorAttachment {
                            view: &view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                        },
                    )],
                    depth_stencil_attachment: None,
                    ..Default::default()
                },
            );
            pass.set_pipeline(&self.crosshair_pipeline);
            pass.set_vertex_buffer(
                0,
                self.crosshair_buf.slice(..),
            );
            pass.draw(0..12, 0..1);
        }

        if let Some(ef) = egui_frame {
            for (id, delta) in &ef.textures_delta.set {
                self.egui_renderer.update_texture(
                    &self.device,
                    &self.queue,
                    *id,
                    delta,
                );
            }
            let mut extra =
                self.egui_renderer.update_buffers(
                    &self.device,
                    &self.queue,
                    &mut encoder,
                    &ef.primitives,
                    &ef.screen_descriptor,
                );
            {
                let mut rpass = encoder
                    .begin_render_pass(
                    &wgpu::RenderPassDescriptor {
                        label: Some("egui"),
                        color_attachments: &[Some(
                            wgpu::RenderPassColorAttachment {
                                view: &view,
                                resolve_target: None,
                                ops: wgpu::Operations {
                                    load: wgpu::LoadOp::Load,
                                    store: wgpu::StoreOp::Store,
                                },
                            },
                        )],
                        depth_stencil_attachment: None,
                        ..Default::default()
                    },
                )
                .forget_lifetime();
                self.egui_renderer.render(
                    &mut rpass,
                    &ef.primitives,
                    &ef.screen_descriptor,
                );
            }
            extra.push(encoder.finish());
            self.queue.submit(extra);
            for id in &ef.textures_delta.free {
                self.egui_renderer.free_texture(id);
            }
        } else {
            self.queue.submit(
                std::iter::once(encoder.finish()),
            );
        }
        output.present();
    }
}

// ── Matrix helpers (column-major) ─────────────────────

fn mat4_mul_col(
    a: &[f32; 16],
    b: &[f32; 16],
) -> [f32; 16] {
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
