//! Per-frame uniform data uploaded to `@group(0) @binding(0)`.

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};

/// GPU-layout struct.  **Must** match `FrameUBO` in all shaders.
///
/// Std140 padding rules apply; fields are ordered to avoid gaps.
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct FrameUBO {
    pub view_proj:      [f32; 16],
    pub prev_view_proj: [f32; 16],
    pub view:           [f32; 16],
    pub proj:           [f32; 16],
    /// World-space camera position.
    pub cam_pos:        [f32; 3],
    /// Elapsed time in seconds (wraps at 3600 s).
    pub time:           f32,
    /// Normalised sun-light direction (pointing toward sun).
    pub sun_dir:        [f32; 3],
    pub sun_intensity:  f32,
    pub screen_size:    [f32; 2],
    pub near_z:         f32,
    pub far_z:          f32,
}

impl FrameUBO {
    pub fn from_data(d: &FrameData, w: u32, h: u32) -> Self {
        Self {
            view_proj:      d.view_proj.to_cols_array(),
            prev_view_proj: d.prev_view_proj.to_cols_array(),
            view:           d.view.to_cols_array(),
            proj:           d.proj.to_cols_array(),
            cam_pos:        d.cam_pos.to_array(),
            time:           d.time,
            sun_dir:        d.sun_dir.to_array(),
            sun_intensity:  d.sun_intensity,
            screen_size:    [w as f32, h as f32],
            near_z:         d.near_z,
            far_z:          d.far_z,
        }
    }
}

/// CPU-side per-frame data.  Populate this each frame before calling
/// [`VoidborneRenderer::render`].
pub struct FrameData {
    pub view:           Mat4,
    pub proj:           Mat4,
    pub view_proj:      Mat4,
    pub prev_view_proj: Mat4,
    pub cam_pos:        Vec3,
    pub sun_dir:        Vec3,
    pub sun_intensity:  f32,
    pub time:           f32,
    pub near_z:         f32,
    pub far_z:          f32,
}

impl Default for FrameData {
    fn default() -> Self {
        Self {
            view:           Mat4::IDENTITY,
            proj:           Mat4::IDENTITY,
            view_proj:      Mat4::IDENTITY,
            prev_view_proj: Mat4::IDENTITY,
            cam_pos:        Vec3::ZERO,
            sun_dir:        Vec3::new(0.3, 0.9, 0.2).normalize(),
            sun_intensity:  6.0,
            time:           0.0,
            near_z:         0.1,
            far_z:          1024.0,
        }
    }
}

/// Cascade matrices for CSM shadows (4 cascades).
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct CascadeUBO {
    pub view_proj: [[f32; 16]; 4],
}

/// Per-chunk origin pushed via a small uniform buffer (group 2).
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct ChunkOriginUBO {
    /// World-space chunk origin (xyz) + padding.
    pub origin: [f32; 4],
}
