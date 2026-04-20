use crate::world::block::{block_face_tiles, is_opaque, BlockType};

pub const CHUNK_SIZE: usize = 16;
const TOTAL: usize = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 4096
const N: usize = CHUNK_SIZE;

#[inline]
fn idx(x: usize, y: usize, z: usize) -> usize {
    x + z * N + y * N * N
}

// ── Greedy mesh face definitions ─────────────────────

struct SliceDef {
    face_index: usize,
    slice_axis: usize,
    dim0: usize,
    dim1: usize,
    neighbor: [i32; 3],
    normal_sign: i32,
    light: f32,
}

/// Per-face TBN: [nx, ny, nz, tx, ty, tz, bitangent_sign]
/// Face order: [+Y, -Y, +X, -X, +Z, -Z]
const FACE_TBN: [[f32; 7]; 6] = [
    [0.0, 1.0, 0.0, 1.0, 0.0, 0.0, -1.0],   // +Y
    [0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 1.0],   // -Y
    [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, -1.0],   // +X
    [-1.0, 0.0, 0.0, 0.0, 0.0, -1.0, -1.0], // -X
    [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0],    // +Z
    [0.0, 0.0, -1.0, -1.0, 0.0, 0.0, 1.0],  // -Z
];

const SLICES: [SliceDef; 6] = [
    SliceDef {
        face_index: 0,
        slice_axis: 1,
        dim0: 0,
        dim1: 2,
        neighbor: [0, 1, 0],
        normal_sign: 1,
        light: 1.0,
    }, // +Y
    SliceDef {
        face_index: 1,
        slice_axis: 1,
        dim0: 0,
        dim1: 2,
        neighbor: [0, -1, 0],
        normal_sign: -1,
        light: 0.5,
    }, // -Y
    SliceDef {
        face_index: 2,
        slice_axis: 0,
        dim0: 2,
        dim1: 1,
        neighbor: [1, 0, 0],
        normal_sign: 1,
        light: 0.8,
    }, // +X
    SliceDef {
        face_index: 3,
        slice_axis: 0,
        dim0: 2,
        dim1: 1,
        neighbor: [-1, 0, 0],
        normal_sign: -1,
        light: 0.8,
    }, // -X
    SliceDef {
        face_index: 4,
        slice_axis: 2,
        dim0: 0,
        dim1: 1,
        neighbor: [0, 0, 1],
        normal_sign: 1,
        light: 0.7,
    }, // +Z
    SliceDef {
        face_index: 5,
        slice_axis: 2,
        dim0: 0,
        dim1: 1,
        neighbor: [0, 0, -1],
        normal_sign: -1,
        light: 0.7,
    }, // -Z
];

// ── Mesh output ──────────────────────────────────────

pub struct ChunkMesh {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    /// [localU, localV, tileIndex, light] per vertex
    pub uvls: Vec<f32>,
    /// [tx, ty, tz, bitangent_sign] per vertex
    pub tangents: Vec<f32>,
    /// [skyLight/15, blockLight/15] per vertex
    pub lights: Vec<f32>,
    pub vertex_count: u32,
}

pub struct ChunkSnapshot {
    pub cx: i32,
    pub cz: i32,
    pub blocks: Vec<u8>,
}

// ── Light sampling helper (world-aware) ──────────────

/// Callback used by the mesh builder to sample light at
/// a world-space position (for cross-chunk sampling).
pub trait LightSampler {
    fn sky_light(&self, wx: i32, wy: i32, wz: i32) -> u8;
    fn block_light(&self, wx: i32, wy: i32, wz: i32) -> u8;
}

// ── Chunk ─────────────────────────────────────────────

#[derive(Clone)]
pub struct Chunk {
    pub blocks: Vec<u8>,
    pub sky_light: Vec<u8>,
    pub block_light: Vec<u8>,
    pub cx: i32,
    pub cz: i32,
}

impl Chunk {
    pub fn new(cx: i32, cz: i32) -> Self {
        Self {
            blocks: vec![0u8; TOTAL],
            sky_light: vec![0u8; TOTAL],
            block_light: vec![0u8; TOTAL],
            cx,
            cz,
        }
    }

    pub fn get_block(&self, x: i32, y: i32, z: i32) -> BlockType {
        if x < 0 || x >= N as i32 || y < 0 || y >= N as i32 || z < 0 || z >= N as i32 {
            return BlockType::Air;
        }
        BlockType::from_u8(self.blocks[idx(x as usize, y as usize, z as usize)])
    }

    pub fn set_block(&mut self, x: usize, y: usize, z: usize, t: BlockType) {
        self.blocks[idx(x, y, z)] = t as u8;
    }

    pub fn get_sky_light(&self, x: i32, y: i32, z: i32) -> u8 {
        if y >= N as i32 {
            return 15;
        }
        if x < 0 || x >= N as i32 || y < 0 || z < 0 || z >= N as i32 {
            return 0;
        }
        self.sky_light[idx(x as usize, y as usize, z as usize)]
    }

    pub fn get_block_light(&self, x: i32, y: i32, z: i32) -> u8 {
        if x < 0 || x >= N as i32 || y < 0 || y >= N as i32 || z < 0 || z >= N as i32 {
            return 0;
        }
        self.block_light[idx(x as usize, y as usize, z as usize)]
    }

    pub fn to_snapshot(&self) -> ChunkSnapshot {
        ChunkSnapshot {
            cx: self.cx,
            cz: self.cz,
            blocks: self.blocks.clone(),
        }
    }

    pub fn from_snapshot(s: ChunkSnapshot) -> Self {
        let mut c = Self::new(s.cx, s.cz);
        c.blocks = s.blocks;
        c
    }

    /// Build a greedy mesh. Pass a `LightSampler` (the
    /// World) for correct cross-chunk boundary lighting.
    pub fn build_mesh(&self, sampler: Option<&dyn LightSampler>) -> ChunkMesh {
        let mut positions: Vec<f32> = Vec::new();
        let mut uvls: Vec<f32> = Vec::new();
        let mut normals: Vec<f32> = Vec::new();
        let mut tangents: Vec<f32> = Vec::new();
        let mut lights: Vec<f32> = Vec::new();

        let mut mask = vec![-1i32; N * N];
        let mut used = vec![0u8; N * N];
        let mut coord = [0i32; 3];

        for sl in &SLICES {
            let SliceDef {
                face_index,
                slice_axis,
                dim0,
                dim1,
                neighbor,
                normal_sign,
                light,
            } = sl;

            for s in 0..N {
                // ── 1. Build visibility mask ──────────────
                mask.fill(-1);
                for j in 0..N {
                    for i in 0..N {
                        coord[*slice_axis] = s as i32;
                        coord[*dim0] = i as i32;
                        coord[*dim1] = j as i32;

                        let block = self.get_block(coord[0], coord[1], coord[2]);
                        if block == BlockType::Air {
                            continue;
                        }

                        let nx = coord[0] + neighbor[0];
                        let ny = coord[1] + neighbor[1];
                        let nz = coord[2] + neighbor[2];
                        if self.get_block(nx, ny, nz) != BlockType::Air {
                            continue;
                        }

                        // Sample light at air-side neighbor
                        let (sky_l, block_l) = if let Some(ws) = sampler {
                            let wx = self.cx * N as i32 + nx;
                            let wz = self.cz * N as i32 + nz;
                            (ws.sky_light(wx, ny, wz), ws.block_light(wx, ny, wz))
                        } else {
                            (
                                self.get_sky_light(nx, ny, nz),
                                self.get_block_light(nx, ny, nz),
                            )
                        };

                        let tiles = block_face_tiles(block);
                        let tile_idx = tiles[*face_index] as i32;
                        mask[i + j * N] =
                            tile_idx | ((sky_l as i32) << 4) | ((block_l as i32) << 8);
                    }
                }

                // ── 2&3. Greedy sweep → emit quads ───────
                used.fill(0);
                for j in 0..N {
                    for i in 0..N {
                        if used[i + j * N] != 0 {
                            continue;
                        }
                        let encoded = mask[i + j * N];
                        if encoded < 0 {
                            continue;
                        }

                        // Grow width along dim0
                        let mut w = 1usize;
                        while i + w < N
                            && used[i + w + j * N] == 0
                            && mask[i + w + j * N] == encoded
                        {
                            w += 1;
                        }

                        // Grow height along dim1
                        let mut h = 1usize;
                        'expand: while j + h < N {
                            for k in i..i + w {
                                if used[k + (j + h) * N] != 0 || mask[k + (j + h) * N] != encoded {
                                    break 'expand;
                                }
                            }
                            h += 1;
                        }

                        // Mark used
                        for dj in 0..h {
                            for di in 0..w {
                                used[i + di + (j + dj) * N] = 1;
                            }
                        }

                        let tile_idx = (encoded & 0xf) as f32;
                        let sky_l = ((encoded >> 4) & 0xf) as f32;
                        let block_l = ((encoded >> 8) & 0xf) as f32;

                        let sv = if *normal_sign > 0 {
                            (s + 1) as i32
                        } else {
                            s as i32
                        };

                        // Helper to build a position
                        let p = |sa: i32, da: i32, db: i32| -> [f32; 3] {
                            let mut c = [0f32; 3];
                            c[*slice_axis] = sa as f32;
                            c[*dim0] = da as f32;
                            c[*dim1] = db as f32;
                            c
                        };

                        let ii = i as i32;
                        let jj = j as i32;
                        let ww = w as i32;
                        let hh = h as i32;

                        // Four corners per face index
                        // (pos, [u, v])
                        let corners: [([f32; 3], [f32; 2]); 4] = match face_index {
                            0 => [
                                // +Y
                                (p(sv, ii, jj), [0.0, 0.0]),
                                (p(sv, ii, jj + hh), [0.0, hh as f32]),
                                (p(sv, ii + ww, jj + hh), [ww as f32, hh as f32]),
                                (p(sv, ii + ww, jj), [ww as f32, 0.0]),
                            ],
                            1 => [
                                // -Y
                                (p(sv, ii, jj), [0.0, 0.0]),
                                (p(sv, ii + ww, jj), [ww as f32, 0.0]),
                                (p(sv, ii + ww, jj + hh), [ww as f32, hh as f32]),
                                (p(sv, ii, jj + hh), [0.0, hh as f32]),
                            ],
                            2 => [
                                // +X
                                (p(sv, ii, jj), [0.0, 0.0]),
                                (p(sv, ii, jj + hh), [0.0, hh as f32]),
                                (p(sv, ii + ww, jj + hh), [ww as f32, hh as f32]),
                                (p(sv, ii + ww, jj), [ww as f32, 0.0]),
                            ],
                            3 => [
                                // -X (reversed U)
                                (p(sv, ii + ww, jj), [0.0, 0.0]),
                                (p(sv, ii + ww, jj + hh), [0.0, hh as f32]),
                                (p(sv, ii, jj + hh), [ww as f32, hh as f32]),
                                (p(sv, ii, jj), [ww as f32, 0.0]),
                            ],
                            4 => [
                                // +Z
                                (p(sv, ii, jj), [0.0, 0.0]),
                                (p(sv, ii + ww, jj), [ww as f32, 0.0]),
                                (p(sv, ii + ww, jj + hh), [ww as f32, hh as f32]),
                                (p(sv, ii, jj + hh), [0.0, hh as f32]),
                            ],
                            _ => [
                                // -Z (reversed U)
                                (p(sv, ii + ww, jj), [0.0, 0.0]),
                                (p(sv, ii, jj), [ww as f32, 0.0]),
                                (p(sv, ii, jj + hh), [ww as f32, hh as f32]),
                                (p(sv, ii + ww, jj + hh), [0.0, hh as f32]),
                            ],
                        };

                        let tbn = FACE_TBN[*face_index];
                        let sky_n = sky_l / 15.0;
                        let block_n = block_l / 15.0;

                        // Two triangles: (0,1,2) (0,2,3)
                        for vi in [0, 1, 2, 0, 2, 3] {
                            let (pos, uv) = &corners[vi];
                            positions.extend_from_slice(pos);
                            uvls.extend_from_slice(&[uv[0], uv[1], tile_idx, *light]);
                            normals.extend_from_slice(&[tbn[0], tbn[1], tbn[2]]);
                            tangents.extend_from_slice(&[tbn[3], tbn[4], tbn[5], tbn[6]]);
                            lights.extend_from_slice(&[sky_n, block_n]);
                        }
                    }
                }
            }
        }

        let vertex_count = (positions.len() / 3) as u32;
        ChunkMesh {
            positions,
            normals,
            uvls,
            tangents,
            lights,
            vertex_count,
        }
    }
}
