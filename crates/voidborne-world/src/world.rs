//! World container: infinite-XZ column grid.

use ahash::AHashMap;

use voidborne_math::ChunkPos;

use crate::block::{block_registry, BlockState};
use crate::column::ChunkColumn;
use crate::light::LightVolume;

// ── Column with optional light ────────────────────────

/// A loaded chunk column with optional lighting data.
pub struct LoadedColumn {
    pub column: ChunkColumn,
    pub light: Option<Box<LightVolume>>,
}

impl LoadedColumn {
    pub fn new(pos: ChunkPos) -> Self {
        Self {
            column: ChunkColumn::new(pos),
            light: None,
        }
    }

    /// Lazily allocate the light volume.
    pub fn ensure_light(&mut self) -> &mut LightVolume {
        self.light.get_or_insert_with(|| Box::new(LightVolume::new()))
    }

    // Delegate the most common column methods.

    #[inline]
    pub fn get(&self, lx: u8, y: i32, lz: u8) -> BlockState {
        self.column.get(lx, y, lz)
    }

    #[inline]
    pub fn set(&mut self, lx: u8, y: i32, lz: u8, state: BlockState) {
        self.column.set(lx, y, lz, state);
    }

    #[inline]
    pub fn height(&self, lx: u8, lz: u8) -> i32 {
        self.column.height(lx, lz)
    }
}

// ── World ─────────────────────────────────────────────

pub struct World {
    pub columns: AHashMap<ChunkPos, LoadedColumn>,
}

impl World {
    pub fn new() -> Self {
        Self {
            columns: AHashMap::new(),
        }
    }

    pub fn load_empty_column(&mut self, pos: ChunkPos) {
        self.columns
            .entry(pos)
            .or_insert_with(|| LoadedColumn::new(pos));
    }

    pub fn get_block(&self, wx: i32, wy: i32, wz: i32) -> BlockState {
        if wy < crate::MIN_Y || wy > crate::MAX_Y {
            return BlockState::AIR;
        }
        let cx = wx.div_euclid(16);
        let cz = wz.div_euclid(16);
        let lx = wx.rem_euclid(16) as u8;
        let lz = wz.rem_euclid(16) as u8;
        self.columns
            .get(&ChunkPos::new(cx, cz))
            .map(|c| c.get(lx, wy, lz))
            .unwrap_or(BlockState::AIR)
    }

    pub fn set_block(&mut self, wx: i32, wy: i32, wz: i32, state: BlockState) {
        let cx = wx.div_euclid(16);
        let cz = wz.div_euclid(16);
        let lx = wx.rem_euclid(16) as u8;
        let lz = wz.rem_euclid(16) as u8;
        if let Some(col) = self.columns.get_mut(&ChunkPos::new(cx, cz)) {
            col.set(lx, wy, lz, state);
        }
    }

    pub fn sky_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        if wy > crate::MAX_Y {
            return 15;
        }
        if wy < crate::MIN_Y {
            return 0;
        }
        let cx = wx.div_euclid(16);
        let cz = wz.div_euclid(16);
        let lx = wx.rem_euclid(16) as u8;
        let lz = wz.rem_euclid(16) as u8;
        self.columns
            .get(&ChunkPos::new(cx, cz))
            .and_then(|c| c.light.as_deref())
            .map(|lv| lv.sky(lx, wy, lz))
            .unwrap_or(0)
    }

    pub fn block_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        if wy < crate::MIN_Y || wy > crate::MAX_Y {
            return 0;
        }
        let cx = wx.div_euclid(16);
        let cz = wz.div_euclid(16);
        let lx = wx.rem_euclid(16) as u8;
        let lz = wz.rem_euclid(16) as u8;
        self.columns
            .get(&ChunkPos::new(cx, cz))
            .and_then(|c| c.light.as_deref())
            .map(|lv| lv.block(lx, wy, lz))
            .unwrap_or(0)
    }
}

// Implement LightSampler for World so the mesher can use it.
impl crate::mesh::LightSampler for World {
    fn sky_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        self.sky_light(wx, wy, wz)
    }

    fn block_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        self.block_light(wx, wy, wz)
    }
}
