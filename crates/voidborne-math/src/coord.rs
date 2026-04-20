//! Voxel coordinate types.
//!
//! The world uses Minecraft-parity scale:
//! - `CHUNK_SIZE` = 16 — horizontal extent of a column (XZ).
//! - `SECTION_SIZE` = 16 — vertical extent of a single cubic
//!   section (Y). A column stacks multiple sections to cover the
//!   world height (e.g. `-64..320` → 24 sections).

use glam::{IVec2, IVec3};

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

pub const CHUNK_SIZE: i32 = 16;
pub const SECTION_SIZE: i32 = 16;

/// Absolute block position in world space.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct BlockPos(pub IVec3);

impl BlockPos {
    #[inline]
    pub const fn new(x: i32, y: i32, z: i32) -> Self {
        Self(IVec3::new(x, y, z))
    }

    #[inline]
    pub fn chunk(self) -> ChunkPos {
        ChunkPos(IVec2::new(
            self.0.x.div_euclid(CHUNK_SIZE),
            self.0.z.div_euclid(CHUNK_SIZE),
        ))
    }

    #[inline]
    pub fn section(self) -> SectionPos {
        let c = self.chunk();
        SectionPos {
            chunk: c,
            section_y: self.0.y.div_euclid(SECTION_SIZE),
        }
    }

    /// Position inside the enclosing section (0..16 on each axis).
    #[inline]
    pub fn local(self) -> LocalPos {
        LocalPos::new(
            self.0.x.rem_euclid(CHUNK_SIZE) as u8,
            self.0.y.rem_euclid(SECTION_SIZE) as u8,
            self.0.z.rem_euclid(CHUNK_SIZE) as u8,
        )
    }
}

/// Chunk column coordinate (XZ plane).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct ChunkPos(pub IVec2);

impl ChunkPos {
    #[inline]
    pub const fn new(x: i32, z: i32) -> Self {
        Self(IVec2::new(x, z))
    }

    #[inline]
    pub fn origin_block(self) -> BlockPos {
        BlockPos::new(self.0.x * CHUNK_SIZE, 0, self.0.y * CHUNK_SIZE)
    }
}

/// A single cubic section within a column.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct SectionPos {
    pub chunk: ChunkPos,
    pub section_y: i32,
}

impl SectionPos {
    #[inline]
    pub fn origin_block(self) -> BlockPos {
        let c = self.chunk.origin_block();
        BlockPos::new(c.0.x, self.section_y * SECTION_SIZE, c.0.z)
    }
}

/// Position within a section (each axis 0..16).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct LocalPos {
    pub x: u8,
    pub y: u8,
    pub z: u8,
}

impl LocalPos {
    #[inline]
    pub const fn new(x: u8, y: u8, z: u8) -> Self {
        debug_assert!(x < 16 && y < 16 && z < 16);
        Self { x, y, z }
    }

    /// Linear index used by section storage: `x | (z<<4) | (y<<8)`.
    #[inline]
    pub const fn index(self) -> usize {
        (self.x as usize) | ((self.z as usize) << 4) | ((self.y as usize) << 8)
    }

    #[inline]
    pub const fn from_index(i: usize) -> Self {
        debug_assert!(i < 4096);
        Self::new(
            (i & 0xF) as u8,
            ((i >> 8) & 0xF) as u8,
            ((i >> 4) & 0xF) as u8,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_to_chunk_and_local() {
        let b = BlockPos::new(-1, 5, 33);
        assert_eq!(b.chunk(), ChunkPos::new(-1, 2));
        let l = b.local();
        assert_eq!((l.x, l.y, l.z), (15, 5, 1));
    }

    #[test]
    fn local_index_roundtrip() {
        for i in 0..4096 {
            assert_eq!(LocalPos::from_index(i).index(), i);
        }
    }

    #[test]
    fn section_origin() {
        let s = SectionPos {
            chunk: ChunkPos::new(2, -3),
            section_y: -1,
        };
        let o = s.origin_block();
        assert_eq!(o.0.x, 32);
        assert_eq!(o.0.y, -16);
        assert_eq!(o.0.z, -48);
    }
}
