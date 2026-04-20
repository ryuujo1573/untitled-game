//! BFS voxel light propagation for the new multi-section world.
//!
//! Ported and generalised from `game/src/world/light.rs`.
//!
//! Two independent channels — sky light and block light — are
//! computed in separate BFS passes over the `World`'s column store.
//! Both use level-bucketed queues (16 buckets, 0..=15) for
//! O(affected_blocks) amortised cost.
//!
//! ## Key changes vs the old single-height chunk system
//!
//! - Y ranges from `MIN_Y` to `MAX_Y` (−64..319), handled by asking
//!   the world for block/light values at world-absolute Y.
//! - A dedicated `LightVolume` per column stores sky + block light
//!   separate from block data.
//! - The sky column pass uses the per-column heightmap to start the
//!   BFS only at the first transparent position below the sky top.

use ahash::AHashMap;

use voidborne_math::ChunkPos;

use crate::{MAX_Y, MIN_Y, World};
use crate::block::block_registry;

const DIRS: [[i32; 3]; 6] = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
];

// ── LightVolume ───────────────────────────────────────

/// Per-column sky + block light storage.
/// Indexed as `lx | (lz << 4) | (section_local_y << 8)` within
/// each section, sections bottom-to-top.
pub struct LightVolume {
    /// One byte per block: upper nibble = sky, lower nibble = block.
    pub data: Vec<u8>,
}

impl LightVolume {
    pub fn new() -> Self {
        let height = (MAX_Y - MIN_Y + 1) as usize; // 384
        Self {
            data: vec![0u8; 16 * height * 16],
        }
    }

    fn flat_index(lx: u8, y: i32, lz: u8) -> usize {
        let local_y = (y - MIN_Y) as usize;
        (lx as usize) | (local_y << 8) | ((lz as usize) << 4)
    }

    pub fn sky(&self, lx: u8, y: i32, lz: u8) -> u8 {
        (self.data[Self::flat_index(lx, y, lz)] >> 4) & 0xF
    }

    pub fn block(&self, lx: u8, y: i32, lz: u8) -> u8 {
        self.data[Self::flat_index(lx, y, lz)] & 0xF
    }

    fn set_sky(&mut self, lx: u8, y: i32, lz: u8, v: u8) {
        let i = Self::flat_index(lx, y, lz);
        self.data[i] = (self.data[i] & 0x0F) | (v << 4);
    }

    fn set_block(&mut self, lx: u8, y: i32, lz: u8, v: u8) {
        let i = Self::flat_index(lx, y, lz);
        self.data[i] = (self.data[i] & 0xF0) | (v & 0xF);
    }

    pub fn reset(&mut self) {
        self.data.fill(0);
    }
}

// ── World helpers ─────────────────────────────────────

/// Fetch a block at absolute world coordinates; returns Air for
/// out-of-bounds or missing columns.
fn world_block(world: &World, wx: i32, wy: i32, wz: i32) -> crate::block::BlockState {
    if wy < MIN_Y || wy > MAX_Y {
        return crate::block::BlockState::AIR;
    }
    let cx = wx.div_euclid(16);
    let cz = wz.div_euclid(16);
    let lx = wx.rem_euclid(16) as u8;
    let lz = wz.rem_euclid(16) as u8;
    match world.columns.get(&ChunkPos::new(cx, cz)) {
        Some(col) => col.get(lx, wy, lz),
        None => crate::block::BlockState::AIR,
    }
}

fn get_sky(world: &World, wx: i32, wy: i32, wz: i32) -> u8 {
    if wy > MAX_Y {
        return 15;
    }
    if wy < MIN_Y {
        return 0;
    }
    let cx = wx.div_euclid(16);
    let cz = wz.div_euclid(16);
    let lx = wx.rem_euclid(16) as u8;
    let lz = wz.rem_euclid(16) as u8;
    world.columns.get(&ChunkPos::new(cx, cz))
        .and_then(|c| c.light.as_deref())
        .map(|lv| lv.sky(lx, wy, lz))
        .unwrap_or(0)
}

fn set_sky(world: &mut World, wx: i32, wy: i32, wz: i32, v: u8) {
    let cx = wx.div_euclid(16);
    let cz = wz.div_euclid(16);
    let lx = wx.rem_euclid(16) as u8;
    let lz = wz.rem_euclid(16) as u8;
    if let Some(col) = world.columns.get_mut(&ChunkPos::new(cx, cz)) {
        col.ensure_light().set_sky(lx, wy, lz, v);
    }
}

fn get_block_light(world: &World, wx: i32, wy: i32, wz: i32) -> u8 {
    if wy < MIN_Y || wy > MAX_Y {
        return 0;
    }
    let cx = wx.div_euclid(16);
    let cz = wz.div_euclid(16);
    let lx = wx.rem_euclid(16) as u8;
    let lz = wz.rem_euclid(16) as u8;
    world.columns.get(&ChunkPos::new(cx, cz))
        .and_then(|c| c.light.as_deref())
        .map(|lv| lv.block(lx, wy, lz))
        .unwrap_or(0)
}

fn set_block_light(world: &mut World, wx: i32, wy: i32, wz: i32, v: u8) {
    let cx = wx.div_euclid(16);
    let cz = wz.div_euclid(16);
    let lx = wx.rem_euclid(16) as u8;
    let lz = wz.rem_euclid(16) as u8;
    if let Some(col) = world.columns.get_mut(&ChunkPos::new(cx, cz)) {
        col.ensure_light().set_block(lx, wy, lz, v);
    }
}

fn make_buckets() -> [Vec<[i32; 3]>; 16] {
    std::array::from_fn(|_| Vec::new())
}

// ── Full-world recompute ──────────────────────────────

/// Recompute sky and block light for every loaded column.
pub fn recompute_world_light(world: &mut World) {
    let reg = block_registry();

    // Reset.
    for col in world.columns.values_mut() {
        if let Some(lv) = col.light.as_deref_mut() {
            lv.reset();
        } else {
            col.light = Some(Box::new(LightVolume::new()));
        }
    }

    let keys: Vec<ChunkPos> = world.columns.keys().copied().collect();

    // ── Phase 1: sky column pass ──────────────────────
    let mut sky_queue = make_buckets();

    for &pos in &keys {
        let bx = pos.0.x * 16;
        let bz = pos.0.y * 16;

        // Collect heights without holding an active borrow on `world`.
        let heights: Vec<(i32, i32, i32)> = {
            let col = world.columns.get(&pos).unwrap();
            let mut v = Vec::with_capacity(256);
            for lz in 0..16i32 {
                for lx in 0..16i32 {
                    v.push((lx, lz, col.height(lx as u8, lz as u8)));
                }
            }
            v
        };
        for (lx, lz, height) in heights {
            for y in (height + 1..=MAX_Y).rev() {
                set_sky(world, bx + lx, y, bz + lz, 15);
                sky_queue[15].push([bx + lx, y, bz + lz]);
            }
        }
    }

    // ── Phase 2: sky BFS ─────────────────────────────
    bfs_spread(world, &mut sky_queue, true);

    // ── Phase 3: block-light BFS ──────────────────────
    let mut block_queue = make_buckets();

    for &pos in &keys {
        let bx = pos.0.x * 16;
        let bz = pos.0.y * 16;

        // Collect emitters without holding a live borrow on `world`.
        let emitters: Vec<(i32, i32, i32, u8)> = {
            let col = world.columns.get(&pos).unwrap();
            let mut v = Vec::new();
            for y in MIN_Y..=MAX_Y {
                for lz in 0..16i32 {
                    for lx in 0..16i32 {
                        let state = col.get(lx as u8, y, lz as u8);
                        let e = reg.emission(state);
                        if e > 0 {
                            v.push((lx, y, lz, e));
                        }
                    }
                }
            }
            v
        };
        for (lx, y, lz, e) in emitters {
            set_block_light(world, bx + lx, y, bz + lz, e);
            block_queue[e as usize].push([bx + lx, y, bz + lz]);
        }
    }

    bfs_spread(world, &mut block_queue, false);
}

fn bfs_spread(
    world: &mut World,
    queue: &mut [Vec<[i32; 3]>; 16],
    is_sky: bool,
) {
    let reg = block_registry();

    for level in (1..=15usize).rev() {
        let seeds = std::mem::take(&mut queue[level]);
        for [wx, wy, wz] in seeds {
            // Stale check.
            let current = if is_sky {
                get_sky(world, wx, wy, wz)
            } else {
                get_block_light(world, wx, wy, wz)
            };
            if current != level as u8 {
                continue;
            }

            let new_level = level - 1;
            for dir in &DIRS {
                let nx = wx + dir[0];
                let ny = wy + dir[1];
                let nz = wz + dir[2];
                if ny < MIN_Y || ny > MAX_Y {
                    continue;
                }

                let nbr = world_block(world, nx, ny, nz);
                if reg.is_opaque(nbr) {
                    continue;
                }

                let cur_nbr = if is_sky {
                    get_sky(world, nx, ny, nz)
                } else {
                    get_block_light(world, nx, ny, nz)
                };

                if cur_nbr < new_level as u8 {
                    if is_sky {
                        set_sky(world, nx, ny, nz, new_level as u8);
                    } else {
                        set_block_light(world, nx, ny, nz, new_level as u8);
                    }
                    if new_level > 0 {
                        queue[new_level].push([nx, ny, nz]);
                    }
                }
            }
        }
    }
}
