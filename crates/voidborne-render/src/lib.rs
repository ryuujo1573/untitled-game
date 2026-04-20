//! `voidborne-render` — render-graph–driven GPU renderer for Voidborne.
//!
//! # Architecture
//!
//! ```text
//!   VoidborneRenderer
//!    ├── GpuContext      (device / queue / surface)
//!    ├── TexturePool     (screen-space render targets)
//!    ├── FrameData       (CPU-side per-frame camera + sun)
//!    ├── GbufferPass     (opaque geometry → RT0-RT3 + depth)
//!    ├── ShadowPass      (depth-only CSM cascades)
//!    ├── LightingPass    (deferred resolve → HDR)
//!    ├── PostPass        (bloom + TAA + ACES tonemap)
//!    └── chunk_meshes[]  (GpuMesh + per-chunk UBO)
//! ```
//!
//! Passes are recorded into a single `CommandEncoder` each frame and
//! submitted in one call.  Wgpu handles resource barriers automatically
//! when switching between render/compute passes.

pub mod context;
pub mod frame_data;
pub mod graph;
pub mod mesh;
pub mod passes;
pub mod renderer;
pub mod texture_pool;

pub use context::GpuContext;
pub use frame_data::{FrameData, FrameUBO};
pub use mesh::GpuMesh;
pub use passes::motion_blur::{MotionBlurQuality, MotionBlurSettings};
pub use renderer::VoidborneRenderer;
pub use texture_pool::{handles, TextureHandle, TexturePool};

// Re-export egui types needed by consumers.
pub use egui;
pub use egui_wgpu;
