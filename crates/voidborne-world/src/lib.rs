//! voidborne-world — voxel world storage, meshing, lighting, and
//! world generation.
//!
//! ## Hierarchy
//!
//! ```text
//! World  (infinite XZ, fixed Y range)
//!   └── ChunkColumn  (16 × Y_RANGE blocks, vertically stacked sections)
//!         └── Section  (16³, paletted bit-packed storage)
//! ```
//!
//! Sections use Mojang-style palette compression: a small per-section
//! palette of unique block-state IDs is kept alongside a bit-packed
//! array.  The bits-per-entry grows automatically (4→5→6→… →direct)
//! so cold/empty sections stay cheap.

pub mod block;
pub mod column;
pub mod light;
pub mod mesh;
pub mod section;
pub mod world;
pub mod worldgen;

pub use block::{block_registry, BlockProperties, BlockState, RawId};
pub use column::ChunkColumn;
pub use section::Section;
pub use world::World;
pub use worldgen::{DefaultOreLayer, DefaultTerrainLayer, DefaultWorldgen, WorldgenLayer};

/// Y range of the world: `MIN_Y..=MAX_Y` (inclusive, blocks).
pub const MIN_Y: i32 = -64;
pub const MAX_Y: i32 = 319;
/// Number of sections stacked per column.
pub const SECTIONS_PER_COLUMN: usize = ((MAX_Y - MIN_Y + 1) / 16) as usize; // 24
