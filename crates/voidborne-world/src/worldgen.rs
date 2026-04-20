//! World generation pipeline.
//!
//! A `WorldgenLayer` trait allows stacking generators:
//! 1. `HeightmapLayer` — determines surface Y per (wx, wz).
//! 2. `TerrainLayer` — fills blocks below the surface.
//! 3. `OreLayer` — scatter ore veins below the surface.
//!
//! `DefaultWorldgen` composes these to reproduce the existing
//! deterministic heightmap + ore hash used in `game/`.

use voidborne_math::ChunkPos;

use crate::block::{block_registry, BlockState};
use crate::column::ChunkColumn;
use crate::world::World;
use crate::MIN_Y;

// ── WorldgenLayer trait ───────────────────────────────

/// Single step in the generation pipeline.  Each layer receives the
/// column being filled and may read/write blocks freely.
pub trait WorldgenLayer: Send + Sync {
    fn generate(&self, col: &mut ChunkColumn, cx: i32, cz: i32);
}

// ── Default heightmap (sine-wave, Minecraft parity) ───

/// Deterministic ore placement hash (ported from `game/`).
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

fn surface_y(wx: i32, wz: i32) -> i32 {
    4 + ((wx as f32 * 0.1).sin() * 2.0
        + (wz as f32 * 0.15).cos() * 2.0) as i32
}

/// Fill blocks in a column based on the default heightmap.
pub struct DefaultTerrainLayer;

impl WorldgenLayer for DefaultTerrainLayer {
    fn generate(&self, col: &mut ChunkColumn, cx: i32, cz: i32) {
        let reg = block_registry();

        let stone_id = reg
            .registry
            .raw_of(&"voidborne:stone".parse().unwrap())
            .expect("stone not registered");
        let dirt_id = reg
            .registry
            .raw_of(&"voidborne:dirt".parse().unwrap())
            .expect("dirt not registered");
        let grass_id = reg
            .registry
            .raw_of(&"voidborne:grass_block".parse().unwrap())
            .expect("grass_block not registered");

        let stone = BlockState { id: stone_id, props: 0 };
        let dirt = BlockState { id: dirt_id, props: 0 };
        let grass = BlockState { id: grass_id, props: 0 };

        let bx = cx * 16;
        let bz = cz * 16;

        for lz in 0..16u8 {
            for lx in 0..16u8 {
                let wx = bx + lx as i32;
                let wz = bz + lz as i32;
                let surface = surface_y(wx, wz);

                for y in MIN_Y..=surface {
                    let state = if y == surface {
                        grass
                    } else if y >= surface - 3 {
                        dirt
                    } else {
                        stone
                    };
                    col.set(lx, y, lz, state);
                }
            }
        }
    }
}

/// Scatter ores using the deterministic hash from `game/`.
pub struct DefaultOreLayer;

impl WorldgenLayer for DefaultOreLayer {
    fn generate(&self, col: &mut ChunkColumn, cx: i32, cz: i32) {
        let reg = block_registry();
        let bx = cx * 16;
        let bz = cz * 16;

        let ore_idents = [
            ("voidborne:coal_ore", 50.0_f32, -64, 120),
            ("voidborne:iron_ore", 60.0, -64, 72),
            ("voidborne:gold_ore", 80.0, -64, 32),
            ("voidborne:diamond_ore", 90.0, -64, 16),
            ("voidborne:emerald_ore", 91.0, -64, 16),
            ("voidborne:lapis_ore", 85.0, -64, 32),
            ("voidborne:redstone_ore", 75.0, -64, 16),
            ("voidborne:copper_ore", 55.0, -48, 96),
        ];

        for &(ident_str, threshold_pct, y_min, y_max) in &ore_idents {
            let raw = match reg.registry.raw_of(&ident_str.parse().unwrap()) {
                Some(r) => r,
                None => continue,
            };
            let ore_state = BlockState { id: raw, props: 0 };

            for y in y_min..=y_max {
                let surface = surface_y(bx, bz); // rough guard
                if y >= surface {
                    continue;
                }
                for lz in 0..16u8 {
                    for lx in 0..16u8 {
                        let wx = bx + lx as i32;
                        let wz = bz + lz as i32;
                        if ore_rng(wx, y, wz) * 100.0 > threshold_pct {
                            continue;
                        }
                        // Only overwrite stone.
                        let stone_id = reg
                            .registry
                            .raw_of(&"voidborne:stone".parse().unwrap())
                            .unwrap();
                        let cur = col.get(lx, y, lz);
                        if cur.id == stone_id {
                            col.set(lx, y, lz, ore_state);
                        }
                    }
                }
            }
        }
    }
}

// ── DefaultWorldgen ───────────────────────────────────

pub struct DefaultWorldgen {
    layers: Vec<Box<dyn WorldgenLayer>>,
}

impl DefaultWorldgen {
    pub fn new() -> Self {
        Self {
            layers: vec![
                Box::new(DefaultTerrainLayer),
                Box::new(DefaultOreLayer),
            ],
        }
    }

    /// Generate and insert a column at `pos` into the world.
    pub fn generate_column(&self, world: &mut World, pos: ChunkPos) {
        world.load_empty_column(pos);
        let col = world.columns.get_mut(&pos).unwrap();
        for layer in &self.layers {
            layer.generate(&mut col.column, pos.0.x, pos.0.y);
        }
        col.column.rebuild_heightmap();
    }

    /// Generate a rectangular region and compute light.
    pub fn generate_region(
        &self,
        world: &mut World,
        cx_min: i32,
        cx_max: i32,
        cz_min: i32,
        cz_max: i32,
    ) {
        for cx in cx_min..=cx_max {
            for cz in cz_min..=cz_max {
                self.generate_column(world, ChunkPos::new(cx, cz));
            }
        }
        crate::light::recompute_world_light(world);
    }
}

impl Default for DefaultWorldgen {
    fn default() -> Self {
        Self::new()
    }
}
