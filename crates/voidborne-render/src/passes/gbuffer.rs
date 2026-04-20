//! G-buffer geometry pass.
//!
//! Renders opaque terrain into four MRTs (albedo, normal+rm,
//! emission+ao, motion+light) plus a depth/stencil attachment.

use wgpu;
use crate::mesh::GpuMesh;
use crate::texture_pool::{handles, TexturePool};

/// Pipeline and bind group layouts for the G-buffer pass.
pub struct GbufferPass {
    pub pipeline:   wgpu::RenderPipeline,
    /// Layout for group 0: FrameUBO.
    pub frame_bgl:  wgpu::BindGroupLayout,
    /// Layout for group 1: block atlas + sampler.
    pub atlas_bgl:  wgpu::BindGroupLayout,
    /// Layout for group 2: per-chunk origin UBO.
    pub chunk_bgl:  wgpu::BindGroupLayout,
}

impl GbufferPass {
    pub fn new(
        device: &wgpu::Device,
        pool: &TexturePool,
    ) -> Self {
        let frame_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("gbuf_frame_bgl"),
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

        let atlas_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("gbuf_atlas_bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension:
                                wgpu::TextureViewDimension::D2Array,
                            sample_type:
                                wgpu::TextureSampleType::Float {
                                    filterable: true,
                                },
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(
                            wgpu::SamplerBindingType::Filtering,
                        ),
                        count: None,
                    },
                ],
            },
        );

        let chunk_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("gbuf_chunk_bgl"),
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
                label: Some("gbuf_layout"),
                bind_group_layouts: &[
                    &frame_bgl,
                    &atlas_bgl,
                    &chunk_bgl,
                ],
                push_constant_ranges: &[],
            },
        );

        let shader = device.create_shader_module(
            wgpu::ShaderModuleDescriptor {
                label: Some("gbuffer_terrain"),
                source: wgpu::ShaderSource::Wgsl(
                    include_str!("../../shaders/gbuffer_terrain.wgsl")
                        .into(),
                ),
            },
        );

        let layouts = crate::mesh::GpuMesh::layouts();

        let pipeline = device.create_render_pipeline(
            &wgpu::RenderPipelineDescriptor {
                label: Some("gbuf_pipeline"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options:
                        wgpu::PipelineCompilationOptions::default(),
                    buffers: &layouts,
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options:
                        wgpu::PipelineCompilationOptions::default(),
                    targets: &[
                        // RT0 albedo
                        Some(wgpu::ColorTargetState {
                            format: pool.format(handles::GBUF_ALBEDO),
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        }),
                        // RT1 normal+roughness+metallic
                        Some(wgpu::ColorTargetState {
                            format: pool.format(handles::GBUF_NORMAL),
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        }),
                        // RT2 emission+ao
                        Some(wgpu::ColorTargetState {
                            format: pool.format(
                                handles::GBUF_EMISSION,
                            ),
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        }),
                        // RT3 motion+light
                        Some(wgpu::ColorTargetState {
                            format: pool.format(handles::GBUF_MOTION),
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        }),
                    ],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: Some(wgpu::Face::Back),
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth24PlusStencil8,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::Less,
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            },
        );

        Self { pipeline, frame_bgl, atlas_bgl, chunk_bgl }
    }

    /// Record the G-buffer pass into `encoder`.
    ///
    /// `chunks` is a slice of `(mesh, chunk_origin_bind_group)` pairs
    /// for all visible chunks.
    pub fn record<'a>(
        &'a self,
        encoder: &mut wgpu::CommandEncoder,
        pool: &'a TexturePool,
        frame_bg: &'a wgpu::BindGroup,
        atlas_bg: &'a wgpu::BindGroup,
        chunks: &'a [(&'a GpuMesh, &'a wgpu::BindGroup)],
    ) {
        let mut pass = encoder.begin_render_pass(
            &wgpu::RenderPassDescriptor {
                label: Some("gbuffer"),
                color_attachments: &[
                    Some(wgpu::RenderPassColorAttachment {
                        view: pool.view(handles::GBUF_ALBEDO),
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(
                                wgpu::Color::TRANSPARENT,
                            ),
                            store: wgpu::StoreOp::Store,
                        },
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: pool.view(handles::GBUF_NORMAL),
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(
                                wgpu::Color::TRANSPARENT,
                            ),
                            store: wgpu::StoreOp::Store,
                        },
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: pool.view(handles::GBUF_EMISSION),
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(
                                wgpu::Color::TRANSPARENT,
                            ),
                            store: wgpu::StoreOp::Store,
                        },
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: pool.view(handles::GBUF_MOTION),
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(
                                wgpu::Color::TRANSPARENT,
                            ),
                            store: wgpu::StoreOp::Store,
                        },
                    }),
                ],
                depth_stencil_attachment: Some(
                    wgpu::RenderPassDepthStencilAttachment {
                        view: pool.view(handles::DEPTH),
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
        pass.set_bind_group(0, frame_bg, &[]);
        pass.set_bind_group(1, atlas_bg, &[]);

        for &(ref mesh, chunk_bg) in chunks {
            pass.set_bind_group(2, chunk_bg, &[]);
            mesh.bind(&mut pass);
            pass.draw(0..mesh.vertex_count, 0..1);
        }
    }
}
