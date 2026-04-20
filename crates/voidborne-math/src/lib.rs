//! voidborne-math — math primitives shared across the voxel engine.
//!
//! Re-exports `glam` for vectors/matrices and adds voxel-specific
//! helpers: block/chunk/section coordinate types, axis-aligned
//! bounding boxes, and common packing routines (octahedral normals,
//! etc.).

pub use glam;

pub mod aabb;
pub mod coord;
pub mod pack;

pub use aabb::Aabb;
pub use coord::{BlockPos, ChunkPos, LocalPos, SectionPos, CHUNK_SIZE, SECTION_SIZE};
