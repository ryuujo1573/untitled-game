//! Post-processing pass: TAA + ACES tonemap.
//!
//! Full-screen triangle reading the HDR buffer and writing directly to
//! the swapchain surface.

use bytemuck::{Pod, Zeroable};
use wgpu;
use wgpu::util::DeviceExt;
use crate::texture_pool::{handles, TexturePool};

/// GPU uniform for post/tonemap settings.
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct PostUBO {
    pub exposure:       f32,
    pub bloom_strength: f32,
    pub taa_blend:      f32,
    pub _pad:           f32,
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

/// Pipeline and layouts for the tonemap/TAA pass.
pub struct PostPass {
    pub pipeline:    wgpu::RenderPipeline,
    /// Layout for group 0: HDR + history + motion + sampler.
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
}

impl PostPass {
    pub fn new(
        device: &wgpu::Device,
        pool: &TexturePool,
        surface_format: wgpu::TextureFormat,
    ) -> Self {
        let hdr_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("post_hdr_bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension:
                                wgpu::TextureViewDimension::D2,
                            sample_type: wgpu::TextureSampleType::Float {
                                filterable: true,
                            },
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension:
                                wgpu::TextureViewDimension::D2,
                            sample_type: wgpu::TextureSampleType::Float {
                                filterable: true,
                            },
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension:
                                wgpu::TextureViewDimension::D2,
                            sample_type: wgpu::TextureSampleType::Float {
                                filterable: true,
                            },
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(
                            wgpu::SamplerBindingType::Filtering,
                        ),
                        count: None,
                    },
                ],
            },
        );

        let post_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
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
            },
        );

        let layout = device.create_pipeline_layout(
            &wgpu::PipelineLayoutDescriptor {
                label: Some("post_layout"),
                bind_group_layouts: &[&hdr_bgl, &post_bgl],
                push_constant_ranges: &[],
            },
        );

        let shader = device.create_shader_module(
            wgpu::ShaderModuleDescriptor {
                label: Some("tonemap"),
                source: wgpu::ShaderSource::Wgsl(
                    include_str!("../../shaders/tonemap.wgsl").into(),
                ),
            },
        );

        let pipeline = device.create_render_pipeline(
            &wgpu::RenderPipelineDescriptor {
                label: Some("post_pipeline"),
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
            },
        );

        let sampler = device.create_sampler(
            &wgpu::SamplerDescriptor {
                label: Some("post_sampler"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            },
        );

        let settings = PostUBO::default();
        let post_buf = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("post_ubo"),
                contents: bytemuck::bytes_of(&settings),
                usage: wgpu::BufferUsages::UNIFORM
                    | wgpu::BufferUsages::COPY_DST,
            },
        );
        let post_bg = device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some("post_bg"),
                layout: &post_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: post_buf.as_entire_binding(),
                }],
            },
        );

        let mut pass = Self {
            pipeline,
            hdr_bgl,
            post_bgl,
            hdr_bg: None,
            sampler,
            post_buf,
            post_bg,
            settings,
        };
        pass.rebuild_hdr_bg(device, pool);
        pass
    }

    /// Recreate the HDR bind group (called on resize).
    pub fn rebuild_hdr_bg(
        &mut self,
        device: &wgpu::Device,
        pool: &TexturePool,
    ) {
        self.hdr_bg = Some(device.create_bind_group(
            &wgpu::BindGroupDescriptor {
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
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::HISTORY_HDR),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::GBUF_MOTION),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Sampler(
                            &self.sampler,
                        ),
                    },
                ],
            },
        ));
    }

    /// Record the tonemap pass writing to `surface_view`.
    pub fn record(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        surface_view: &wgpu::TextureView,
    ) {
        let hdr_bg =
            self.hdr_bg.as_ref().expect("rebuild_hdr_bg not called");

        let mut pass = encoder.begin_render_pass(
            &wgpu::RenderPassDescriptor {
                label: Some("tonemap"),
                color_attachments: &[Some(
                    wgpu::RenderPassColorAttachment {
                        view: surface_view,
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
        pass.set_bind_group(0, hdr_bg, &[]);
        pass.set_bind_group(1, &self.post_bg, &[]);
        pass.draw(0..3, 0..1);
    }
}
