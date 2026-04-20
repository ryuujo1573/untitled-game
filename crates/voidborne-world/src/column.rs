//! `ChunkColumn` — 16-wide vertical column of sections.
//!
//! Covers the Y range `MIN_Y..=MAX_Y` (defined in the crate root).
//! Sections are stored in a fixed-size array ordered bottom to top;
//! section 0 corresponds to the section whose base is at `MIN_Y`.

use voidborne_math::{ChunkPos, SECTION_SIZE};

use crate::block::BlockState;
use crate::section::Section;
use crate::{MIN_Y, SECTIONS_PER_COLUMN};

/// A 16×(world height)×16 column of block data.
pub struct ChunkColumn {
    pub pos: ChunkPos,
    sections: Box<[Section; SECTIONS_PER_COLUMN]>,
    /// Per-column heightmap: highest opaque block Y per (lx, lz),
    /// or `MIN_Y - 1` if the column is all air.
    heightmap: Box<[i32; 16 * 16]>,
}

impl ChunkColumn {
    pub fn new(pos: ChunkPos) -> Self {
        // Box the array to keep it off the stack (24 × Section).
        let sections = std::array::from_fn(|_| Section::new_empty());
        Self {
            pos,
            sections: Box::new(sections),
            heightmap: Box::new([MIN_Y - 1; 16 * 16]),
        }
    }

    // ── Section access ────────────────────────────────

    /// Index of the section that contains absolute Y.
    #[inline]
    pub fn section_index(y: i32) -> usize {
        ((y - MIN_Y) / SECTION_SIZE) as usize
    }

    #[inline]
    pub fn section(&self, section_y: i32) -> &Section {
        &self.sections[Self::section_index(section_y * SECTION_SIZE + MIN_Y)]
    }

    #[inline]
    pub fn section_mut(&mut self, section_y: i32) -> &mut Section {
        &mut self.sections[Self::section_index(section_y * SECTION_SIZE + MIN_Y)]
    }

    // ── Block access ──────────────────────────────────

    /// `y` is the **absolute** world Y.
    pub fn get(&self, lx: u8, y: i32, lz: u8) -> BlockState {
        if y < MIN_Y || y > crate::MAX_Y {
            return BlockState::AIR;
        }
        let si = Self::section_index(y);
        let ly = ((y - MIN_Y) % SECTION_SIZE) as u8;
        self.sections[si].get(lx, ly, lz)
    }

    pub fn set(&mut self, lx: u8, y: i32, lz: u8, state: BlockState) {
        if y < MIN_Y || y > crate::MAX_Y {
            return;
        }
        let si = Self::section_index(y);
        let ly = ((y - MIN_Y) % SECTION_SIZE) as u8;
        self.sections[si].set(lx, ly, lz, state);

        // Update heightmap.
        let hi = lx as usize + lz as usize * 16;
        let is_opaque = crate::block::block_registry().is_opaque(state);
        let current_h = self.heightmap[hi];
        if is_opaque && y > current_h {
            self.heightmap[hi] = y;
        } else if !is_opaque && y == current_h {
            // Rescan downward.
            self.heightmap[hi] = self.scan_height(lx, lz);
        }
    }

    /// Immutable slice of all sections (bottom → top).
    #[inline]
    pub fn sections(&self) -> &[Section; SECTIONS_PER_COLUMN] {
        &self.sections
    }

    // ── Heightmap ─────────────────────────────────────

    pub fn height(&self, lx: u8, lz: u8) -> i32 {
        self.heightmap[lx as usize + lz as usize * 16]
    }

    fn scan_height(&self, lx: u8, lz: u8) -> i32 {
        let reg = crate::block::block_registry();
        for y in (MIN_Y..=crate::MAX_Y).rev() {
            let s = self.get(lx, y, lz);
            if reg.is_opaque(s) {
                return y;
            }
        }
        MIN_Y - 1
    }

    /// Rebuild the entire heightmap from scratch.  Call after bulk
    /// loading a column from disk.
    pub fn rebuild_heightmap(&mut self) {
        for lz in 0..16u8 {
            for lx in 0..16u8 {
                let hi = lx as usize + lz as usize * 16;
                self.heightmap[hi] = self.scan_height(lx, lz);
            }
        }
    }
}
