pub mod block;
pub mod chunk;
pub mod light;

use std::collections::HashMap;

use crate::world::block::BlockType;
use crate::world::chunk::{Chunk, ChunkSnapshot, LightSampler, CHUNK_SIZE};
use crate::world::light::{recompute_local_light, recompute_world_light};

const N: i32 = CHUNK_SIZE as i32;

// ── Deterministic ore hash ────────────────────────────

fn ore_rng(wx: i32, y: i32, wz: i32) -> f32 {
    let mut h = wx
        .wrapping_mul(16807)
        .wrapping_add(y.wrapping_mul(48271))
        .wrapping_add(wz.wrapping_mul(39119));
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b3c6d_u32 as i32);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297a2d39_u32 as i32);
    h ^= h >> 15;
    (h as u32) as f32 / 0x1_0000_0000_u64 as f32
}

fn infer_grid_size(chunks: &HashMap<(i32, i32), Chunk>) -> i32 {
    chunks.keys().map(|(cx, _)| cx + 1).max().unwrap_or(0)
}

// ── World ─────────────────────────────────────────────

pub struct World {
    pub chunks: HashMap<(i32, i32), Chunk>,
    pub grid_size: i32,
}

impl World {
    pub fn new() -> Self {
        Self {
            chunks: HashMap::new(),
            grid_size: 0,
        }
    }

    pub fn get_chunk(&self, cx: i32, cz: i32) -> Option<&Chunk> {
        self.chunks.get(&(cx, cz))
    }

    pub fn get_chunk_mut(&mut self, cx: i32, cz: i32) -> Option<&mut Chunk> {
        self.chunks.get_mut(&(cx, cz))
    }

    pub fn get_block(&self, wx: i32, wy: i32, wz: i32) -> BlockType {
        if wy < 0 {
            return BlockType::Stone;
        }
        if wy >= N {
            return BlockType::Air;
        }
        let cx = wx.div_euclid(N);
        let cz = wz.div_euclid(N);
        let chunk = match self.get_chunk(cx, cz) {
            Some(c) => c,
            None => return BlockType::Air,
        };
        let lx = wx - cx * N;
        let lz = wz - cz * N;
        chunk.get_block(lx, wy, lz)
    }

    pub fn get_sky_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        if wy < 0 {
            return 0;
        }
        if wy >= N {
            return 15;
        }
        let cx = wx.div_euclid(N);
        let cz = wz.div_euclid(N);
        let chunk = match self.get_chunk(cx, cz) {
            Some(c) => c,
            None => return 0,
        };
        let lx = wx - cx * N;
        let lz = wz - cz * N;
        chunk.get_sky_light(lx, wy, lz)
    }

    pub fn get_block_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        if wy < 0 || wy >= N {
            return 0;
        }
        let cx = wx.div_euclid(N);
        let cz = wz.div_euclid(N);
        let chunk = match self.get_chunk(cx, cz) {
            Some(c) => c,
            None => return 0,
        };
        let lx = wx - cx * N;
        let lz = wz - cz * N;
        chunk.get_block_light(lx, wy, lz)
    }

    /// Set a block at world coords. Triggers a
    /// localised (3×3 chunk) light recomputation.
    /// Returns the affected chunk key, or None if
    /// out of range.
    pub fn set_block(&mut self, wx: i32, wy: i32, wz: i32, t: BlockType) -> Option<(i32, i32)> {
        if wy < 0 || wy >= N {
            return None;
        }
        let cx = wx.div_euclid(N);
        let cz = wz.div_euclid(N);
        {
            let chunk = self.chunks.get_mut(&(cx, cz))?;
            let lx = (wx - cx * N) as usize;
            let lz = (wz - cz * N) as usize;
            chunk.set_block(lx, wy as usize, lz, t);
        }
        recompute_local_light(self, cx, cz);
        Some((cx, cz))
    }

    /// Generate a gridSize×gridSize terrain with a sine
    /// heightmap + ore distribution matching the TS impl.
    pub fn generate(&mut self, grid_size: i32) {
        self.chunks.clear();
        self.grid_size = grid_size;

        for cx in 0..grid_size {
            for cz in 0..grid_size {
                let mut chunk = Chunk::new(cx, cz);
                let cs = CHUNK_SIZE as i32;

                for lx in 0..cs {
                    for lz in 0..cs {
                        let wx = cx * cs + lx;
                        let wz = cz * cs + lz;

                        let height = (6.0
                            + (wx as f32 * 0.1).sin() * 2.0
                            + (wz as f32 * 0.15).cos() * 2.0
                            + ((wx + wz) as f32 * 0.07).sin() * 1.5)
                            as i32;
                        let h = height.min(cs - 1).max(0);

                        for y in 0..=h {
                            let t = if y == h {
                                BlockType::Grass
                            } else if y >= h - 2 {
                                BlockType::Dirt
                            } else {
                                let r = ore_rng(wx, y, wz);
                                if r < 0.005 {
                                    BlockType::DiamondOre
                                } else if r < 0.013 {
                                    BlockType::EmeraldOre
                                } else if r < 0.028 {
                                    BlockType::GoldOre
                                } else if r < 0.043 {
                                    BlockType::LapisOre
                                } else if r < 0.063 {
                                    BlockType::RedstoneOre
                                } else if r < 0.093 {
                                    BlockType::CopperOre
                                } else if r < 0.143 {
                                    BlockType::IronOre
                                } else if r < 0.223 {
                                    BlockType::CoalOre
                                } else {
                                    BlockType::Stone
                                }
                            };
                            chunk.set_block(lx as usize, y as usize, lz as usize, t);
                        }
                    }
                }
                self.chunks.insert((cx, cz), chunk);
            }
        }

        recompute_world_light(self);
    }

    pub fn to_snapshot(&self) -> WorldSnapshot {
        WorldSnapshot {
            grid_size: self.grid_size.max(infer_grid_size(&self.chunks)),
            chunks: self.chunks.values().map(|c| c.to_snapshot()).collect(),
        }
    }

    pub fn from_snapshot(s: WorldSnapshot) -> Self {
        let mut world = Self::new();
        world.grid_size = s.grid_size;
        for cs in s.chunks {
            let key = (cs.cx, cs.cz);
            world.chunks.insert(key, Chunk::from_snapshot(cs));
        }
        recompute_world_light(&mut world);
        world
    }
}

impl LightSampler for World {
    fn sky_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        self.get_sky_light(wx, wy, wz)
    }
    fn block_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        self.get_block_light(wx, wy, wz)
    }
}

// ── Snapshot types ────────────────────────────────────

pub struct WorldSnapshot {
    pub grid_size: i32,
    pub chunks: Vec<ChunkSnapshot>,
}

// ── Mesh snapshot (off-thread meshing) ───────────────

/// A minimal clone of up to 5 chunks (target + 4
/// cardinal neighbours) used to build a chunk mesh on
/// a background thread without holding a reference to
/// the full `World`.
pub struct MeshSnapshot {
    chunks: HashMap<(i32, i32), Chunk>,
}

impl MeshSnapshot {
    fn get_sky_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        if wy < 0 {
            return 0;
        }
        if wy >= N {
            return 15;
        }
        let cx = wx.div_euclid(N);
        let cz = wz.div_euclid(N);
        match self.chunks.get(&(cx, cz)) {
            Some(c) => {
                let lx = wx - cx * N;
                let lz = wz - cz * N;
                c.get_sky_light(lx, wy, lz)
            }
            None => 0,
        }
    }

    fn get_block_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        if wy < 0 || wy >= N {
            return 0;
        }
        let cx = wx.div_euclid(N);
        let cz = wz.div_euclid(N);
        match self.chunks.get(&(cx, cz)) {
            Some(c) => {
                let lx = wx - cx * N;
                let lz = wz - cz * N;
                c.get_block_light(lx, wy, lz)
            }
            None => 0,
        }
    }

    pub fn get_chunk(&self, cx: i32, cz: i32) -> Option<&Chunk> {
        self.chunks.get(&(cx, cz))
    }
}

impl LightSampler for MeshSnapshot {
    fn sky_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        self.get_sky_light(wx, wy, wz)
    }
    fn block_light(&self, wx: i32, wy: i32, wz: i32) -> u8 {
        self.get_block_light(wx, wy, wz)
    }
}

impl World {
    /// Clone the target chunk and its four cardinal
    /// neighbours into a `MeshSnapshot` that can be
    /// sent to a background thread for meshing.
    pub fn mesh_snapshot(&self, cx: i32, cz: i32) -> MeshSnapshot {
        let offsets: [(i32, i32); 5] = [(0, 0), (-1, 0), (1, 0), (0, -1), (0, 1)];
        let mut chunks = HashMap::new();
        for (dx, dz) in offsets {
            let key = (cx + dx, cz + dz);
            if let Some(chunk) = self.chunks.get(&key) {
                chunks.insert(key, chunk.clone());
            }
        }
        MeshSnapshot { chunks }
    }
}
