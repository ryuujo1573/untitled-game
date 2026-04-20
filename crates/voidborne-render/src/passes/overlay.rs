//! Overlay pass: block-selection outline (3-D LineList) and
//! screen-space crosshair (2-D TriangleList).
//!
//! Both sub-passes render on top of the swapchain surface view that
//! the post/tonemap pass just wrote, using `LoadOp::Load`.
//! The outline sub-pass depth-tests against the G-buffer depth so that
//! the outline is correctly occluded by terrain.

use wgpu;
use wgpu::util::DeviceExt;

use crate::texture_pool::{handles, TexturePool};

/// Builds the cube outline vertices for a block at `(bx, by, bz)`.
///
/// Returns 24 positions forming 12 line segments (edges of a 1³ cube,
/// expanded by a small epsilon so the lines sit just outside the surface).
pub fn outline_verts(bx: i32, by: i32, bz: i32) -> [[f32; 3]; 24] {
    let e = 0.003_f32; // expand slightly
    let x0 = bx as f32 - e;
    let y0 = by as f32 - e;
    let z0 = bz as f32 - e;
    let x1 = bx as f32 + 1.0 + e;
    let y1 = by as f32 + 1.0 + e;
    let z1 = bz as f32 + 1.0 + e;
    [
        // bottom face edges
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x1, y0, z1],
        [x0, y0, z1],
        [x0, y0, z1],
        [x0, y0, z0],
        // top face edges
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y1, z1],
        [x0, y1, z1],
        [x0, y1, z1],
        [x0, y1, z0],
        // vertical edges
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y0, z1],
        [x0, y1, z1],
    ]
}

// ── Crosshair NDC geometry ────────────────────────────────────────────

#[rustfmt::skip]
const CROSSHAIR_VERTS: [f32; 24] = [
    // horizontal bar
    -0.025, -0.003,  0.025, -0.003,  0.025,  0.003,
    -0.025, -0.003,  0.025,  0.003, -0.025,  0.003,
    // vertical bar
    -0.003, -0.025,  0.003, -0.025,  0.003,  0.025,
    -0.003, -0.025,  0.003,  0.025, -0.003,  0.025,
];

// ── OverlayPass ───────────────────────────────────────────────────────

pub struct OverlayPass {
    outline_pipeline: wgpu::RenderPipeline,
    outline_buf: wgpu::Buffer, // 24 × 3 f32 = 288 B, COPY_DST
    crosshair_pipeline: wgpu::RenderPipeline,
    crosshair_buf: wgpu::Buffer,
    /// Frame bind group layout shared with the rest of the pipeline
    /// (group 0, binding 0 = FrameUBO).  Stored so we can assert
    /// compatibility; the actual bind group is owned by the renderer.
    pub frame_bgl: wgpu::BindGroupLayout,
}

impl OverlayPass {
    pub fn new(device: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("overlay"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/overlay.wgsl").into()),
        });

        // Frame bind group layout (FrameUBO at binding 0).
        let frame_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("overlay_frame_bgl"),
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

        // ── Outline pipeline ─────────────────────────────────────────
        let outline_pl_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("outline_pl"),
            bind_group_layouts: &[&frame_bgl],
            push_constant_ranges: &[],
        });

        let outline_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("outline"),
            layout: Some(&outline_pl_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("outline_vs"),
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
                module: &shader,
                entry_point: Some("outline_fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                ..Default::default()
            },
            // Read-only depth test against G-buffer depth.
            // The G-buffer uses Depth24PlusStencil8.
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24PlusStencil8,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        let outline_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("outline_verts"),
            size: (24 * 3 * 4) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // ── Crosshair pipeline ───────────────────────────────────────
        let crosshair_pl_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("crosshair_pl"),
            bind_group_layouts: &[],
            push_constant_ranges: &[],
        });

        let crosshair_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("crosshair"),
            layout: Some(&crosshair_pl_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("crosshair_vs"),
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
                module: &shader,
                entry_point: Some("crosshair_fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
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

        let crosshair_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("crosshair_verts"),
            contents: bytemuck::cast_slice(&CROSSHAIR_VERTS),
            usage: wgpu::BufferUsages::VERTEX,
        });

        Self {
            outline_pipeline,
            outline_buf,
            crosshair_pipeline,
            crosshair_buf,
            frame_bgl,
        }
    }

    /// Record outline (if `targeted_block` is `Some`) and crosshair onto
    /// `surface_view` (which is already populated by the post/tonemap pass).
    pub fn record(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        queue: &wgpu::Queue,
        surface_view: &wgpu::TextureView,
        pool: &TexturePool,
        frame_bg: &wgpu::BindGroup,
        targeted_block: Option<[i32; 3]>,
    ) {
        let depth_view = pool.view(handles::DEPTH);

        // ── Outline ──────────────────────────────────────────────────
        if let Some([bx, by, bz]) = targeted_block {
            let verts = outline_verts(bx, by, bz);
            queue.write_buffer(&self.outline_buf, 0, bytemuck::cast_slice(&verts));

            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("overlay_outline"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: surface_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            pass.set_pipeline(&self.outline_pipeline);
            pass.set_bind_group(0, frame_bg, &[]);
            pass.set_vertex_buffer(0, self.outline_buf.slice(..));
            pass.draw(0..24, 0..1);
        }

        // ── Crosshair ────────────────────────────────────────────────
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("overlay_crosshair"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: surface_view,
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
    }
}
