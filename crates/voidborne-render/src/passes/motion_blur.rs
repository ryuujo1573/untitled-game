//! Motion blur post-process pass.
//!
//! Reads the HDR colour buffer and GBUF_MOTION velocity buffer, then
//! accumulates colour samples along each pixel's motion vector using a
//! Gaussian kernel.  The result is written to [`handles::MOTION_BLUR_HDR`],
//! which the subsequent tonemap/TAA pass consumes.
//!
//! # Pipeline position
//! ```text
//! GbufferPass → ShadowPass → LightingPass → SkyPass
//!     → **MotionBlurPass**  (HDR + GBUF_MOTION → MOTION_BLUR_HDR)
//!     → PostPass (tonemap reads MOTION_BLUR_HDR)
//! ```
//!
//! # Runtime control
//! Call [`MotionBlurPass::update_settings`] every frame (or whenever
//! settings change) to push a new [`MotionBlurUBO`] to the GPU.  Setting
//! [`MotionBlurSettings::enabled`] to `false` zeroes out `intensity` in
//! the UBO so the shader copies the HDR buffer without any blurring.

use bytemuck::{Pod, Zeroable};
use wgpu;
use wgpu::util::DeviceExt;

use crate::texture_pool::{handles, TexturePool};

// ── Player-facing settings ────────────────────────────────────────

/// Number of HDR samples taken along the blur direction per pixel.
///
/// Higher values improve quality at the cost of fragment throughput.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionBlurQuality {
    /// 4 samples — minimal performance cost, visible banding on fast objects.
    Low    = 4,
    /// 8 samples — balanced default for mid-range hardware.
    Medium = 8,
    /// 16 samples — smooth blur for high-end or cinematic modes.
    High   = 16,
}

/// CPU-side motion blur configuration.
///
/// Pass to [`MotionBlurPass::update_settings`] to update the GPU uniform.
#[derive(Clone, Debug)]
pub struct MotionBlurSettings {
    /// When `false`, intensity is forced to 0.0 and the pass becomes a
    /// transparent copy, adding no visual cost beyond a render pass dispatch.
    pub enabled:   bool,
    /// Scale applied to motion vectors before sampling (0.0 – 1.0).
    /// Values above 1.0 are accepted but may produce unnatural results.
    pub intensity: f32,
    /// Controls the sample count (quality / performance trade-off).
    pub quality:   MotionBlurQuality,
    /// When `true`, the pass outputs a colour-coded velocity visualisation
    /// instead of the blurred scene.  Useful for debugging.
    pub debug_viz: bool,
}

impl Default for MotionBlurSettings {
    fn default() -> Self {
        Self {
            enabled:   true,
            intensity: 1.0,
            quality:   MotionBlurQuality::Medium,
            debug_viz: false,
        }
    }
}

// ── GPU uniform ───────────────────────────────────────────────────

/// GPU-layout uniform.  **Must** match `MotionBlurUBO` in motion_blur.wgsl.
///
/// Std140 layout: 4 × 4-byte fields = 16 bytes, naturally aligned.
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct MotionBlurUBO {
    /// Effective intensity: `settings.intensity` when enabled, else 0.0.
    pub intensity:    f32,
    /// Sample count along the blur direction (4 / 8 / 16).
    pub sample_count: u32,
    /// Squared UV-space velocity threshold.  Pixels below this are not
    /// blurred.  Tuned so sub-pixel jitter from static cameras is ignored.
    pub threshold_sq: f32,
    /// 0 = normal output; 1 = velocity colour-map visualisation.
    pub debug_mode:   u32,
}

impl MotionBlurUBO {
    pub fn from_settings(s: &MotionBlurSettings) -> Self {
        Self {
            intensity:    if s.enabled { s.intensity } else { 0.0 },
            sample_count: s.quality as u32,
            threshold_sq: 0.0005 * 0.0005, // ~½ pixel at 1080p
            debug_mode:   s.debug_viz as u32,
        }
    }
}

// ── Pass ──────────────────────────────────────────────────────────

/// Motion blur post-process pass.
///
/// Create once via [`MotionBlurPass::new`]; call [`rebuild_tex_bg`] on
/// window resize; call [`record`] each frame between sky and post passes.
pub struct MotionBlurPass {
    pub pipeline: wgpu::RenderPipeline,
    /// Layout for group 0: MotionBlurUBO.
    pub mb_bgl:   wgpu::BindGroupLayout,
    /// Layout for group 1: HDR + motion textures + sampler.
    pub tex_bgl:  wgpu::BindGroupLayout,
    /// Uniform buffer (MotionBlurUBO).
    pub mb_buf:   wgpu::Buffer,
    /// Bind group for group 0 (stable; not rebuilt on resize).
    pub mb_bg:    wgpu::BindGroup,
    /// Bind group for group 1 (rebuilt on resize).
    pub tex_bg:   Option<wgpu::BindGroup>,
    /// Linear-clamp sampler shared for both textures.
    pub sampler:  wgpu::Sampler,
    /// Last-applied settings (for introspection).
    pub settings: MotionBlurSettings,
}

impl MotionBlurPass {
    /// Create the pipeline and initial bind groups.
    pub fn new(device: &wgpu::Device, pool: &TexturePool) -> Self {
        // ── Bind group layout 0: MotionBlurUBO ───────────
        let mb_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("mb_ubo_bgl"),
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

        // ── Bind group layout 1: textures + sampler ───────
        let tex_bgl = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("mb_tex_bgl"),
                entries: &[
                    // 0: hdr_tex
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            sample_type: wgpu::TextureSampleType::Float {
                                filterable: true,
                            },
                        },
                        count: None,
                    },
                    // 1: motion_tex (GBUF_MOTION)
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            sample_type: wgpu::TextureSampleType::Float {
                                filterable: true,
                            },
                        },
                        count: None,
                    },
                    // 2: sampler
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(
                            wgpu::SamplerBindingType::Filtering,
                        ),
                        count: None,
                    },
                ],
            },
        );

        // ── Pipeline layout + shader ──────────────────────
        let layout = device.create_pipeline_layout(
            &wgpu::PipelineLayoutDescriptor {
                label: Some("mb_layout"),
                bind_group_layouts: &[&mb_bgl, &tex_bgl],
                push_constant_ranges: &[],
            },
        );

        let shader = device.create_shader_module(
            wgpu::ShaderModuleDescriptor {
                label: Some("motion_blur"),
                source: wgpu::ShaderSource::Wgsl(
                    include_str!("../../shaders/motion_blur.wgsl").into(),
                ),
            },
        );

        let pipeline = device.create_render_pipeline(
            &wgpu::RenderPipelineDescriptor {
                label: Some("mb_pipeline"),
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
                    // Output format matches MOTION_BLUR_HDR target.
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
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

        // ── Sampler (linear, clamp-to-edge) ──────────────
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("mb_sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });

        // ── UBO ───────────────────────────────────────────
        let settings = MotionBlurSettings::default();
        let ubo = MotionBlurUBO::from_settings(&settings);
        let mb_buf = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("mb_ubo"),
                contents: bytemuck::bytes_of(&ubo),
                usage: wgpu::BufferUsages::UNIFORM
                    | wgpu::BufferUsages::COPY_DST,
            },
        );
        let mb_bg = device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some("mb_ubo_bg"),
                layout: &mb_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: mb_buf.as_entire_binding(),
                }],
            },
        );

        let mut pass = Self {
            pipeline,
            mb_bgl,
            tex_bgl,
            mb_buf,
            mb_bg,
            tex_bg: None,
            sampler,
            settings,
        };
        pass.rebuild_tex_bg(device, pool);
        pass
    }

    /// Recreate the texture bind group after a resize or pool rebuild.
    pub fn rebuild_tex_bg(
        &mut self,
        device: &wgpu::Device,
        pool: &TexturePool,
    ) {
        self.tex_bg = Some(device.create_bind_group(
            &wgpu::BindGroupDescriptor {
                label: Some("mb_tex_bg"),
                layout: &self.tex_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::HDR),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(
                            pool.view(handles::GBUF_MOTION),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(
                            &self.sampler,
                        ),
                    },
                ],
            },
        ));
    }

    /// Update GPU-side settings.  Call this whenever the player changes
    /// quality, intensity, or the enabled flag.
    pub fn update_settings(
        &mut self,
        queue: &wgpu::Queue,
        settings: MotionBlurSettings,
    ) {
        self.settings = settings;
        let ubo = MotionBlurUBO::from_settings(&self.settings);
        queue.write_buffer(&self.mb_buf, 0, bytemuck::bytes_of(&ubo));
    }

    /// Record the motion blur render pass into `encoder`.
    ///
    /// Reads [`handles::HDR`] + [`handles::GBUF_MOTION`].  
    /// Writes to [`handles::MOTION_BLUR_HDR`].
    pub fn record(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        pool: &TexturePool,
    ) {
        let tex_bg = self
            .tex_bg
            .as_ref()
            .expect("MotionBlurPass: rebuild_tex_bg not called");

        let mut pass = encoder.begin_render_pass(
            &wgpu::RenderPassDescriptor {
                label: Some("motion_blur"),
                color_attachments: &[Some(
                    wgpu::RenderPassColorAttachment {
                        view: pool.view(handles::MOTION_BLUR_HDR),
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
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
        pass.set_bind_group(0, &self.mb_bg, &[]);
        pass.set_bind_group(1, tex_bg, &[]);
        pass.draw(0..3, 0..1);
    }
}
