//! Cascaded shadow map (CSM) depth-only pass.
//!
//! Renders into a 4096×4096 Depth32Float 2D-array texture (4 layers,
//! one per cascade).  The cascade view-proj matrices are supplied via a
//! small per-cascade uniform buffer.

use bytemuck;
use wgpu;
use wgpu::util::DeviceExt;
use crate::frame_data::CascadeUBO;
use crate::mesh::GpuMesh;
use crate::texture_pool::TexturePool;

/// Pipeline and bind group layouts for the CSM shadow pass.
pub struct ShadowPass {
    pub pipeline:      wgpu::RenderPipeline,
    /// Layout for group 0: single cascade view-proj UBO.
    pub cascade_bgl:   wgpu::BindGroupLayout,
    /// Layout for group 1: chunk origin UBO.
    pub chunk_bgl:     wgpu::BindGroupLayout,
}

impl ShadowPass {
    pub fn new(device: &wgpu::Device) -> Self {
        let cascade_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("shadow_cascade_bgl"),
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

        let chunk_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("shadow_chunk_bgl"),
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

        let layout = device.create_pipeline_layout(
            &wgpu::PipelineLayoutDescriptor {
                label: Some("shadow_layout"),
                bind_group_layouts: &[&cascade_bgl, &chunk_bgl],
                push_constant_ranges: &[],
            },
        );

        let shader = device.create_shader_module(
            wgpu::ShaderModuleDescriptor {
                label: Some("shadow_depth"),
                source: wgpu::ShaderSource::Wgsl(
                    include_str!("../../shaders/shadow_depth.wgsl")
                        .into(),
                ),
            },
        );

        // Depth-only pipeline (no colour attachments).
        let pipeline = device.create_render_pipeline(
            &wgpu::RenderPipelineDescriptor {
                label: Some("shadow_pipeline"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options:
                        wgpu::PipelineCompilationOptions::default(),
                    // Only slot 0 (positions) is needed.
                    buffers: &[wgpu::VertexBufferLayout {
                        array_stride: 12,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &[wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: 0,
                            shader_location: 0,
                        }],
                    }],
                },
                fragment: None,
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: Some(wgpu::Face::Front), // reverse cull
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth32Float,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::Less,
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState {
                        constant: 2,
                        slope_scale: 2.0,
                        clamp: 0.0,
                    },
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            },
        );

        Self { pipeline, cascade_bgl, chunk_bgl }
    }

    /// Record one shadow pass for a single cascade into `encoder`.
    ///
    /// `cascade_view_proj` — the light's view-proj for this cascade.
    /// `cascade_view`      — the depth texture view for this cascade.
    pub fn record_cascade<'a>(
        &'a self,
        encoder: &mut wgpu::CommandEncoder,
        device: &wgpu::Device,
        cascade_view: &'a wgpu::TextureView,
        cascade_view_proj: [[f32; 16]; 4],
        chunks: &[(&GpuMesh, &wgpu::Buffer)],
    ) {
        // Upload a per-cascade view-proj.
        let single_vp = cascade_view_proj[0]; // use first cascade slot
        let cascade_buf = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("cascade_buf"),
                contents: bytemuck::bytes_of(&single_vp),
                usage: wgpu::BufferUsages::UNIFORM,
            },
        );
        let cascade_bg = device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some("cascade_bg"),
                layout: &self.cascade_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: cascade_buf.as_entire_binding(),
                }],
            },
        );

        let mut pass = encoder.begin_render_pass(
            &wgpu::RenderPassDescriptor {
                label: Some("shadow"),
                color_attachments: &[],
                depth_stencil_attachment: Some(
                    wgpu::RenderPassDepthStencilAttachment {
                        view: cascade_view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    },
                ),
                timestamp_writes: None,
                occlusion_query_set: None,
            },
        );

        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &cascade_bg, &[]);

        for (mesh, chunk_origin_buf) in chunks {
            let chunk_bg = device.create_bind_group(
                &wgpu::BindGroupDescriptor {
                    label: Some("shadow_chunk_bg"),
                    layout: &self.chunk_bgl,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: chunk_origin_buf.as_entire_binding(),
                    }],
                },
            );
            pass.set_bind_group(1, &chunk_bg, &[]);
            pass.set_vertex_buffer(0, mesh.pos_buf.slice(..));
            pass.draw(0..mesh.vertex_count, 0..1);
        }
    }
}
