//! Screen-space render target pool.
//!
//! All viewport-size textures live here.  Call [`TexturePool::rebuild`]
//! whenever the swapchain is resized.

use wgpu;

/// Opaque index into the pool.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct TextureHandle(pub u32);

/// Well-known handles.  Indices **must** match the insertion order in
/// [`TexturePool::rebuild`].
pub mod handles {
    use super::TextureHandle;
    pub const GBUF_ALBEDO: TextureHandle = TextureHandle(0);
    pub const GBUF_NORMAL: TextureHandle = TextureHandle(1);
    pub const GBUF_EMISSION: TextureHandle = TextureHandle(2);
    pub const GBUF_MOTION: TextureHandle = TextureHandle(3);
    pub const DEPTH: TextureHandle = TextureHandle(4);
    pub const SHADOW_CSM: TextureHandle = TextureHandle(5);
    pub const HDR: TextureHandle = TextureHandle(6);
    pub const HIZ: TextureHandle = TextureHandle(7);
    pub const PREV_DEPTH: TextureHandle = TextureHandle(8);
    pub const HISTORY_HDR: TextureHandle = TextureHandle(9);
    /// Motion-blurred HDR — output of the motion blur pass; consumed by tonemap.
    pub const MOTION_BLUR_HDR: TextureHandle = TextureHandle(10);
}

pub struct PooledTexture {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub format: wgpu::TextureFormat,
    pub width: u32,
    pub height: u32,
}

/// Per-cascade view into the CSM shadow depth array.
pub struct ShadowCascadeViews {
    pub cascade: [wgpu::TextureView; 4],
    pub full: wgpu::TextureView,
}

pub struct TexturePool {
    entries: Vec<PooledTexture>,
    pub shadow_views: Option<ShadowCascadeViews>,
}

impl TexturePool {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            shadow_views: None,
        }
    }

    /// Recreate all screen-size targets for the given dimensions.
    pub fn rebuild(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        self.entries.clear();
        self.shadow_views = None;

        let w = width;
        let h = height;

        let color = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        let storage_color = color | wgpu::TextureUsages::STORAGE_BINDING;
        let depth_usage =
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;

        let mut push = |label: &'static str,
                        format: wgpu::TextureFormat,
                        usage: wgpu::TextureUsages,
                        tw: u32,
                        th: u32,
                        layers: u32| {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: tw,
                    height: th,
                    depth_or_array_layers: layers,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            PooledTexture {
                texture,
                view,
                format,
                width: tw,
                height: th,
            }
        };

        // ── G-buffer targets (indices 0-4) ─────────────────────
        // 0: GBUF_ALBEDO  — Rgba8Unorm (linear albedo)
        self.entries.push(push(
            "gbuf_albedo",
            wgpu::TextureFormat::Rgba8Unorm,
            color,
            w,
            h,
            1,
        ));
        // 1: GBUF_NORMAL  — Rgba16Float (oct normal + roughness + metallic)
        self.entries.push(push(
            "gbuf_normal",
            wgpu::TextureFormat::Rgba16Float,
            color,
            w,
            h,
            1,
        ));
        // 2: GBUF_EMISSION — Rgba8Unorm (emission.rgb + AO)
        self.entries.push(push(
            "gbuf_emission",
            wgpu::TextureFormat::Rgba8Unorm,
            color,
            w,
            h,
            1,
        ));
        // 3: GBUF_MOTION  — Rgba16Float (motion.xy + block_light + sky_light)
        self.entries.push(push(
            "gbuf_motion",
            wgpu::TextureFormat::Rgba16Float,
            color,
            w,
            h,
            1,
        ));
        // 4: DEPTH  — Depth24PlusStencil8
        self.entries.push(push(
            "depth",
            wgpu::TextureFormat::Depth24PlusStencil8,
            depth_usage,
            w,
            h,
            1,
        ));

        // 5: SHADOW_CSM — Depth32Float array (4 cascades × 4096²)
        {
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("shadow_csm"),
                size: wgpu::Extent3d {
                    width: 4096,
                    height: 4096,
                    depth_or_array_layers: 4,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth32Float,
                usage: depth_usage,
                view_formats: &[],
            });
            // Full-array view for sampling in the lighting pass.
            let full = tex.create_view(&Default::default());
            // One view per cascade for writing.
            let cascades = std::array::from_fn::<wgpu::TextureView, 4, _>(|i| {
                tex.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: i as u32,
                    array_layer_count: Some(1),
                    ..Default::default()
                })
            });
            self.shadow_views = Some(ShadowCascadeViews {
                cascade: cascades,
                full,
            });
            let view = tex.create_view(&Default::default());
            self.entries.push(PooledTexture {
                texture: tex,
                view,
                format: wgpu::TextureFormat::Depth32Float,
                width: 4096,
                height: 4096,
            });
        }

        // 6: HDR  — Rgba16Float (HDR scene colour)
        self.entries.push(push(
            "hdr",
            wgpu::TextureFormat::Rgba16Float,
            storage_color,
            w,
            h,
            1,
        ));
        // 7: HIZ  — R32Float (Hi-Z min pyramid, 1 mip for now)
        self.entries.push(push(
            "hiz",
            wgpu::TextureFormat::R32Float,
            wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            w,
            h,
            1,
        ));
        // 8: PREV_DEPTH — R32Float copy of last frame's depth
        self.entries.push(push(
            "prev_depth",
            wgpu::TextureFormat::R32Float,
            wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            w,
            h,
            1,
        ));
        // 9: HISTORY_HDR — Rgba16Float for TAA accumulation
        self.entries.push(push(
            "history_hdr",
            wgpu::TextureFormat::Rgba16Float,
            storage_color,
            w,
            h,
            1,
        ));
        // 10: MOTION_BLUR_HDR — Rgba16Float (motion-blurred HDR; input to tonemap)
        self.entries.push(push(
            "motion_blur_hdr",
            wgpu::TextureFormat::Rgba16Float,
            color,
            w,
            h,
            1,
        ));
    }

    pub fn get(&self, h: TextureHandle) -> &PooledTexture {
        &self.entries[h.0 as usize]
    }

    pub fn view(&self, h: TextureHandle) -> &wgpu::TextureView {
        &self.entries[h.0 as usize].view
    }

    pub fn format(&self, h: TextureHandle) -> wgpu::TextureFormat {
        self.entries[h.0 as usize].format
    }
}

impl Default for TexturePool {
    fn default() -> Self {
        Self::new()
    }
}
