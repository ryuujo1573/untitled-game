//! GPU device, queue, surface and adapter management.

use std::sync::Arc;
use wgpu;
use winit::window::Window;

/// Core GPU resources shared by all render passes.
pub struct GpuContext {
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub surface: wgpu::Surface<'static>,
    pub surface_config: wgpu::SurfaceConfiguration,
    pub adapter: wgpu::Adapter,
    /// The swapchain's native surface format.
    pub surface_format: wgpu::TextureFormat,
    /// Subset of [`DESIRED_FEATURES`] that the adapter actually supports.
    pub features: wgpu::Features,
}

/// Feature set we request; missing features degrade gracefully.
const DESIRED_FEATURES: wgpu::Features = wgpu::Features::MULTI_DRAW_INDIRECT
    .union(wgpu::Features::TEXTURE_BINDING_ARRAY)
    .union(
        wgpu::Features::PARTIALLY_BOUND_BINDING_ARRAY,
    )
    .union(
        wgpu::Features::SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING,
    );

impl GpuContext {
    /// Synchronously initialise wgpu from a `winit` window.
    ///
    /// The `Arc<Window>` must outlive `GpuContext`.
    pub fn new(window: Arc<Window>) -> Self {
        pollster::block_on(Self::init(window))
    }

    async fn init(window: Arc<Window>) -> Self {
        let instance = wgpu::Instance::new(
            &wgpu::InstanceDescriptor {
                backends: wgpu::Backends::PRIMARY,
                ..Default::default()
            },
        );

        let surface = instance
            .create_surface(window.clone())
            .expect("failed to create wgpu surface");

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference:
                    wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("no compatible GPU adapter found");

        tracing::info!(
            "wgpu adapter: {:?}",
            adapter.get_info()
        );

        let available = adapter.features();
        let features = available & DESIRED_FEATURES;
        if features != DESIRED_FEATURES {
            tracing::warn!(
                "some optional features unavailable: {:?}",
                DESIRED_FEATURES - features
            );
        }

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("voidborne-device"),
                    required_features: features,
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::default(),
                },
                None,
            )
            .await
            .expect("failed to create wgpu device");

        let size = window.inner_size();
        let caps = surface.get_capabilities(&adapter);

        let surface_format = caps
            .formats
            .iter()
            .find(|f| f.is_srgb())
            .copied()
            .unwrap_or(caps.formats[0]);

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &surface_config);

        Self {
            device: Arc::new(device),
            queue: Arc::new(queue),
            surface,
            surface_config,
            adapter,
            surface_format,
            features,
        }
    }

    /// Resize the swapchain.  No-op if either dimension is 0.
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface.configure(&self.device, &self.surface_config);
    }

    /// Change the swapchain present mode (V-Sync on/off) without a full resize.
    pub fn set_present_mode(&mut self, mode: wgpu::PresentMode) {
        self.surface_config.present_mode = mode;
        self.surface.configure(&self.device, &self.surface_config);
    }

    pub fn width(&self) -> u32 {
        self.surface_config.width
    }

    pub fn height(&self) -> u32 {
        self.surface_config.height
    }
}
