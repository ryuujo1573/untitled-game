//! Paletted bit-packed storage for a 16³ section (4096 blocks).
//!
//! Follows Mojang's "indirect palette" scheme:
//! - A per-section palette maps small integer indices to `BlockState`
//!   values.
//! - The 4096 entries are stored as palette indices packed into a
//!   `Vec<u64>`, with **no cross-word spanning** (entries are aligned
//!   to word boundaries).
//! - `bits_per_entry` starts at 4 (16 palette slots) and grows to
//!   5, 6, … up to 14 bits as the palette fills.
//!
//! ## Index layout
//! `index(x, y, z) = x | (z << 4) | (y << 8)` — matches
//! `LocalPos::index()` in `voidborne-math`.

use crate::block::BlockState;

const VOLUME: usize = 16 * 16 * 16; // 4096

#[derive(Clone)]
pub struct Section {
    /// Unique block states present in this section, in insertion order.
    /// `palette[0]` is always `BlockState::AIR`.
    palette: Vec<BlockState>,
    /// Packed indices.  Entries do not span u64 boundaries.
    data: Vec<u64>,
    /// Current bits used per palette index.
    bits: u32,
    /// Count of non-air blocks (cheap solid-check).
    non_air: u16,
}

// ── Construction ──────────────────────────────────────

impl Section {
    /// An all-air section (the common case — uses minimal memory).
    pub fn new_empty() -> Self {
        let bits = 4u32;
        Self {
            palette: vec![BlockState::AIR],
            data: vec![0u64; data_words(bits)],
            bits,
            non_air: 0,
        }
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.non_air == 0
    }
}

// ── Helpers ───────────────────────────────────────────

/// Number of palette entries that fit in one u64.
#[inline]
const fn entries_per_word(bits: u32) -> usize {
    (64 / bits) as usize
}

/// Total u64 words needed for 4096 entries.
#[inline]
const fn data_words(bits: u32) -> usize {
    (VOLUME + entries_per_word(bits) - 1) / entries_per_word(bits)
}

/// Block-local index — identical to `LocalPos::index`.
#[inline]
fn idx(x: u8, y: u8, z: u8) -> usize {
    (x as usize) | ((z as usize) << 4) | ((y as usize) << 8)
}

// ── Core get / set ────────────────────────────────────

impl Section {
    pub fn get(&self, x: u8, y: u8, z: u8) -> BlockState {
        let i = idx(x, y, z);
        let epw = entries_per_word(self.bits);
        let word = self.data[i / epw];
        let shift = (i % epw) * self.bits as usize;
        let mask = (1u64 << self.bits) - 1;
        let pi = ((word >> shift) & mask) as usize;
        self.palette[pi]
    }

    pub fn set(&mut self, x: u8, y: u8, z: u8, state: BlockState) {
        let i = idx(x, y, z);

        // Find or allocate palette entry.
        let pi = if let Some(pos) = self.palette.iter().position(|&s| s == state) {
            pos
        } else {
            // Grow palette; repack if needed.
            let pos = self.palette.len();
            if pos >= (1 << self.bits) as usize {
                self.grow();
            }
            self.palette.push(state);
            pos
        };

        // Update non-air counter.
        let old = self.get(x, y, z);
        let air = BlockState::AIR;
        if old == air && state != air {
            self.non_air += 1;
        } else if old != air && state == air {
            self.non_air = self.non_air.saturating_sub(1);
        }

        // Write index.
        self.write_raw(i, pi as u64);
    }

    fn write_raw(&mut self, i: usize, pi: u64) {
        let epw = entries_per_word(self.bits);
        let wi = i / epw;
        let shift = (i % epw) * self.bits as usize;
        let mask = ((1u64 << self.bits) - 1) << shift;
        self.data[wi] = (self.data[wi] & !mask) | (pi << shift);
    }

    /// Increase bits-per-entry by 1 and repack.
    fn grow(&mut self) {
        let old_bits = self.bits;
        let new_bits = old_bits + 1;
        debug_assert!(new_bits <= 14, "palette overflow: > 16384 unique states");

        let old_epw = entries_per_word(old_bits);
        let new_epw = entries_per_word(new_bits);
        let mut new_data = vec![0u64; data_words(new_bits)];

        for i in 0..VOLUME {
            // Read from old layout.
            let old_wi = i / old_epw;
            let old_shift = (i % old_epw) * old_bits as usize;
            let old_mask = (1u64 << old_bits) - 1;
            let pi = (self.data[old_wi] >> old_shift) & old_mask;

            // Write to new layout.
            let new_wi = i / new_epw;
            let new_shift = (i % new_epw) * new_bits as usize;
            let new_mask = ((1u64 << new_bits) - 1) << new_shift;
            new_data[new_wi] = (new_data[new_wi] & !new_mask) | (pi << new_shift);
        }

        self.bits = new_bits;
        self.data = new_data;
    }
}

// ── Palette introspection ─────────────────────────────

impl Section {
    #[inline]
    pub fn palette_len(&self) -> usize {
        self.palette.len()
    }

    #[inline]
    pub fn bits_per_entry(&self) -> u32 {
        self.bits
    }

    /// Unique block states present in this section.
    pub fn palette(&self) -> &[BlockState] {
        &self.palette
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use voidborne_registry::RawId;

    fn state(id: u32) -> BlockState {
        BlockState { id: RawId(id), props: 0 }
    }

    #[test]
    fn empty_section_returns_air() {
        let s = Section::new_empty();
        assert_eq!(s.get(0, 0, 0), BlockState::AIR);
        assert_eq!(s.get(15, 15, 15), BlockState::AIR);
        assert!(s.is_empty());
    }

    #[test]
    fn set_and_get_roundtrip() {
        let mut s = Section::new_empty();
        s.set(3, 7, 11, state(1));
        assert_eq!(s.get(3, 7, 11), state(1));
        // Neighbours untouched
        assert_eq!(s.get(4, 7, 11), BlockState::AIR);
        assert_eq!(s.get(3, 8, 11), BlockState::AIR);
    }

    #[test]
    fn non_air_counter() {
        let mut s = Section::new_empty();
        s.set(0, 0, 0, state(1));
        s.set(1, 0, 0, state(1));
        assert_eq!(s.non_air, 2);
        s.set(0, 0, 0, BlockState::AIR);
        assert_eq!(s.non_air, 1);
    }

    #[test]
    fn palette_grows_with_unique_states() {
        let mut s = Section::new_empty();
        // Fill with 16 different states → palette exhausted at bits=4
        // → must grow to bits=5.
        for id in 0..=16u32 {
            s.set(id as u8 % 16, id as u8 / 16, 0, state(id));
        }
        assert!(s.bits_per_entry() >= 5);
    }

    #[test]
    fn full_roundtrip_all_positions() {
        let mut s = Section::new_empty();
        // Write a checkerboard of two states.
        for y in 0..16u8 {
            for z in 0..16u8 {
                for x in 0..16u8 {
                    let st = if (x + y + z) % 2 == 0 { state(1) } else { state(2) };
                    s.set(x, y, z, st);
                }
            }
        }
        for y in 0..16u8 {
            for z in 0..16u8 {
                for x in 0..16u8 {
                    let expected =
                        if (x + y + z) % 2 == 0 { state(1) } else { state(2) };
                    assert_eq!(s.get(x, y, z), expected, "at ({x},{y},{z})");
                }
            }
        }
    }
}
