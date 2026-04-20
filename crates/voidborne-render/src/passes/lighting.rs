//! Deferred lighting resolve pass.
//!
//! Full-screen triangle reading the G-buffer + CSM shadow atlas.
//! Outputs to the HDR Rgba16Float buffer.

use bytemuck;
use wgpu;
use wgpu::util::DeviceExt;
use crate::frame_data::CascadeUBO;
use crate::texture_pool::{handles, TexturePool};

/// Pipeline and layouts for the deferred lighting pass.
pub struct LightingPass {
    pub pipeline:     wgpu::RenderPipeline,
    /// Layout for group 0: FrameUBO + CascadeUBO.
    pub frame_bgl:    wgpu::BindGroupLayout,
    /// Layout for group 1: G-buffer textures + samplers.
    pub gbuf_bgl:     wgpu::BindGroupLayout,
    /// Current bind group for group 1 (recreated on resize).
    pub gbuf_bg:      Option<wgpu::BindGroup>,
    /// Non-filtering sampler used for G-buffer reads.
    pub sampler:      wgpu::Sampler,
    /// Comparison sampler used for shadow reads.
    pub shadow_sampler: wgpu::Sampler,
}

impl LightingPass {
    pub fn new(
        device: &wgpu::Device,
        pool: &TexturePool,
        surface_format: wgpu::TextureFormat,
    ) -> Self {
        let frame_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("lighting_frame_bgl"),
                entries: &[
                    // binding 0: FrameUBO
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    // binding 1: CascadeUBO
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            },
        );

        let gbuf_bgl = Self::make_gbuf_bgl(device);

        let layout = device.create_pipeline_layout(
            &wgpu::PipelineLayoutDescriptor {
                label: Some("lighting_layout"),
                bind_group_layouts: &[&frame_bgl, &gbuf_bgl],
                push_constant_ranges: &[],
            },
        );

        let shader = device.create_shader_module(
            wgpu::ShaderModuleDescriptor {
                label: Some("deferred_lighting"),
                source: wgpu::ShaderSource::Wgsl(
                    include_str!(
                        "../../shaders/deferred_lighting.wgsl"
                    )
                    .into(),
                ),
            },
        );

        let pipeline = device.create_render_pipeline(
            &wgpu::RenderPipelineDescriptor {
                label: Some("lighting_pipeline"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_fullscreen"),
                    compilation_options:
                        wgpu::PipelineCompilationOptions::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options:
                        wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: pool.format(handles::HDR),
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
            },
        );

        let sampler = device.create_sampler(
            &wgpu::SamplerDescriptor {
                label: Some("lighting_sampler"),
                mag_filter: wgpu::FilterMode::Nearest,
                min_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            },
        );
        let shadow_sampler = device.create_sampler(
            &wgpu::SamplerDescriptor {
                label: Some("shadow_sampler"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                compare: Some(wgpu::CompareFunction::LessEqual),
                ..Default::default()
            },
        );

        let mut pass = Self {
            pipeline,
            frame_bgl,
            gbuf_bgl,
            gbuf_bg: None,
            sampler,
            shadow_sampler,
        };
        pass.rebuild_gbuf_bg(device, pool);
        pass
    }

    fn make_gbuf_bgl(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        use wgpu::{
            BindGroupLayoutEntry as E, BindingType as BT,
            ShaderStages as SS, TextureSampleType as TST,
            TextureViewDimension as TVD,
        };
        device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("lighting_gbuf_bgl"),
                entries: &[
                    E {
                        binding: 0,
                        visibility: SS::FRAGMENT,
                        ty: BT::Texture {
                            multisampled: false,
                            view_dimension: TVD::D2,
                            sample_type: TST::Float {
                                filterable: false,
                            },
                        },
                        count: None,
                    },
                    E {
                        binding: 1,
                        visibility: SS::FRAGMENT,
                        ty: BT::Texture {
                            multisampled: false,
                            view_dimension: TVD::D2,
                            sample_type: TST::Float {
                                filterable: false,
                            },
                        },
                        count: None,
                    },
                    E {
                        binding: 2,
                        visibility: SS::FRAGMENT,
                        ty: BT::Texture {
                            multisampled: false,
                            view_dimension: TVD::D2,
                            sample_type: TST::Float {
                                filterable: false,
                            },
                        },
                        count: None,
                    },
                    E {
                        binding: 3,
                        visibility: SS::FRAGMENT,
                        ty: BT::Texture {
                            multisampled: false,
                            view_dimension: TVD::D2,
                            sample_type: TST::Float {
                                filterable: false,
                            },
                        },
                        count: None,
                    },
                    // binding 4: depth (unfilterable float)
                    E {
                        binding: 4,
                        visibility: SS::FRAGMENT,
                        ty: BT::Texture {
                            multisampled: false,
                            view_dimension: TVD::D2,
                            sample_type: TST::Depth,
                        },
                        count: None,
                    },
                    // binding 5: shadow CSM depth array
                    E {
                        binding: 5,
                        visibility: SS::FRAGMENT,
                        ty: BT::Texture {
                            multisampled: false,
                            view_dimension: TVD::D2Array,
                            sample_type: TST::Depth,
                        },
                        count: None,
                    },
                    // binding 6: non-comparison sampler
                    E {
                        binding: 6,
                        visibility: SS::FRAGMENT,
                        ty: BT::Sampler(
                            wgpu::SamplerBindingType::NonFiltering,
                        ),
                        count: None,
                    },
                    // binding 7: comparison sampler (shadow PCF)
                    E {
                        binding: 7,
                        visibility: SS::FRAGMENT,
                        ty: BT::Sampler(
                            wgpu::SamplerBindingType::Comparison,
                        ),
                        count: None,
                    },
                ],
            },
        )
    }

    /// Recreate the G-buffer bind group (called on resize).
    pub fn rebuild_gbuf_bg(
        &mut self,
        device: &wgpu::Device,
        pool: &TexturePool,
    ) {
        let shadow_full = pool
            .shadow_views
            .as_ref()
            .map(|sv| &sv.full)
            .expect("shadow views must be built before lighting");

        self.gbuf_bg = Some(device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some("lighting_gbuf_bg"),
                layout: &self.gbuf_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::GBUF_ALBEDO),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::GBUF_NORMAL),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::GBUF_EMISSION),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::GBUF_MOTION),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::DEPTH),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: wgpu::BindingResource::TextureView(
                            shadow_full,
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: wgpu::BindingResource::Sampler(
                            &self.sampler,
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 7,
                        resource: wgpu::BindingResource::Sampler(
                            &self.shadow_sampler,
                        ),
                    },
                ],
            },
        ));
    }

    /// Record the lighting pass.
    pub fn record(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        pool: &TexturePool,
        frame_bg: &wgpu::BindGroup,
    ) {
        let gbuf_bg = self
            .gbuf_bg
            .as_ref()
            .expect("rebuild_gbuf_bg not called");

        let mut pass = encoder.begin_render_pass(
            &wgpu::RenderPassDescriptor {
                label: Some("lighting"),
                color_attachments: &[Some(
                    wgpu::RenderPassColorAttachment {
                        view: pool.view(handles::HDR),
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(
                                wgpu::Color::BLACK,
                            ),
                            store: wgpu::StoreOp::Store,
                        },
                    },
                )],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            },
        );

        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, frame_bg, &[]);
        pass.set_bind_group(1, gbuf_bg, &[]);
        pass.draw(0..3, 0..1); // full-screen triangle
    }
}
