//! BFS voxel light propagation — sky light + block light.
//!
//! Phase 1: sky column pass — mark all air above first
//!           solid as skyLight=15.
//! Phase 2: BFS spread sky light horizontally (attenuates).
//! Phase 3: BFS spread block light from emissive seeds.

use std::collections::HashSet;

use crate::world::block::{is_opaque, BLOCK_EMISSION};
use crate::world::chunk::CHUNK_SIZE;
use crate::world::World;

const N: i32 = CHUNK_SIZE as i32;

const DIRS: [[i32; 3]; 6] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];

fn make_buckets() -> Vec<Vec<[i32; 3]>> {
    (0..16).map(|_| Vec::new()).collect()
}

pub fn recompute_world_light(world: &mut World) {
    // ── Reset ────────────────────────────────────────
    for chunk in world.chunks.values_mut() {
        chunk.sky_light.fill(0);
        chunk.block_light.fill(0);
    }

    // ── Phase 1: sky column pass ─────────────────────
    let mut sky_queue = make_buckets();

    // Collect chunk keys to avoid borrow issues
    let keys: Vec<(i32, i32)> = world.chunks.keys().copied().collect();

    for (cx, cz) in &keys {
        let cx = *cx;
        let cz = *cz;
        let bx = cx * N;
        let bz = cz * N;

        let chunk = world.chunks.get_mut(&(cx, cz)).unwrap();
        for lx in 0..N {
            for lz in 0..N {
                for y in (0..N).rev() {
                    if is_opaque(chunk.get_block(lx, y, lz)) {
                        break;
                    }
                    let i = (lx + lz * N + y * N * N) as usize;
                    chunk.sky_light[i] = 15;
                    sky_queue[15].push([bx + lx, y, bz + lz]);
                }
            }
        }
    }

    // ── Phase 2: BFS sky spread ───────────────────────
    for level in (1..=15usize).rev() {
        let seeds = std::mem::take(&mut sky_queue[level]);
        for pos in seeds {
            let [wx, wy, wz] = pos;
            let cx = wx.div_euclid(N);
            let cz = wz.div_euclid(N);
            let lx = wx - cx * N;
            let lz = wz - cz * N;
            let i = (lx + lz * N + wy * N * N) as usize;

            // Stale check
            {
                let chunk = match world.chunks.get(&(cx, cz)) {
                    Some(c) => c,
                    None => continue,
                };
                if chunk.sky_light[i] != level as u8 {
                    continue;
                }
            }

            let new_level = level - 1;
            for dir in &DIRS {
                let nx = wx + dir[0];
                let ny = wy + dir[1];
                let nz = wz + dir[2];
                if ny < 0 || ny >= N {
                    continue;
                }
                let ncx = nx.div_euclid(N);
                let ncz = nz.div_euclid(N);
                let nlx = nx - ncx * N;
                let nlz = nz - ncz * N;
                let ni = (nlx + nlz * N + ny * N * N) as usize;

                let chunk = match world.chunks.get_mut(&(ncx, ncz)) {
                    Some(c) => c,
                    None => continue,
                };
                if is_opaque(chunk.get_block(nlx, ny, nlz)) {
                    continue;
                }
                if chunk.sky_light[ni] < new_level as u8 {
                    chunk.sky_light[ni] = new_level as u8;
                    if new_level > 0 {
                        sky_queue[new_level].push([nx, ny, nz]);
                    }
                }
            }
        }
    }

    // ── Phase 3: block-light BFS ─────────────────────
    let mut block_queue = make_buckets();

    for (cx, cz) in &keys {
        let cx = *cx;
        let cz = *cz;
        let bx = cx * N;
        let bz = cz * N;

        let chunk = world.chunks.get_mut(&(cx, cz)).unwrap();
        for lx in 0..N {
            for ly in 0..N {
                for lz in 0..N {
                    let bt = chunk.get_block(lx, ly, lz);
                    let emission = BLOCK_EMISSION[bt as usize];
                    if emission > 0 {
                        let i = (lx + lz * N + ly * N * N) as usize;
                        chunk.block_light[i] = emission;
                        block_queue[emission as usize].push([bx + lx, ly, bz + lz]);
                    }
                }
            }
        }
    }

    for level in (1..=15usize).rev() {
        let seeds = std::mem::take(&mut block_queue[level]);
        for pos in seeds {
            let [wx, wy, wz] = pos;
            let cx = wx.div_euclid(N);
            let cz = wz.div_euclid(N);
            let lx = wx - cx * N;
            let lz = wz - cz * N;
            let i = (lx + lz * N + wy * N * N) as usize;

            {
                let chunk = match world.chunks.get(&(cx, cz)) {
                    Some(c) => c,
                    None => continue,
                };
                if chunk.block_light[i] != level as u8 {
                    continue;
                }
            }

            let new_level = level - 1;
            for dir in &DIRS {
                let nx = wx + dir[0];
                let ny = wy + dir[1];
                let nz = wz + dir[2];
                if ny < 0 || ny >= N {
                    continue;
                }
                let ncx = nx.div_euclid(N);
                let ncz = nz.div_euclid(N);
                let nlx = nx - ncx * N;
                let nlz = nz - ncz * N;
                let ni = (nlx + nlz * N + ny * N * N) as usize;

                let chunk = match world.chunks.get_mut(&(ncx, ncz)) {
                    Some(c) => c,
                    None => continue,
                };
                if is_opaque(chunk.get_block(nlx, ny, nlz)) {
                    continue;
                }
                if chunk.block_light[ni] < new_level as u8 {
                    chunk.block_light[ni] = new_level as u8;
                    if new_level > 0 {
                        block_queue[new_level].push([nx, ny, nz]);
                    }
                }
            }
        }
    }
}

// ── Localised light update ────────────────────────────
//
// Recomputes light only within the 3×3 chunk region
// centred on (center_cx, center_cz).  Since sky/block
// light attenuates by 1 per block and max level is 15,
// a single-block change can affect at most 15 blocks
// (< 1 chunk radius) in any direction, so this region
// is always sufficient for correctness.
//
// Light from chunks *outside* the region is preserved
// by seeding the BFS from each external border face
// before running the BFS — the condition
// `sky_light[ni] < new_level` prevents overwrites, so
// the external data is never corrupted.
pub fn recompute_local_light(world: &mut World, center_cx: i32, center_cz: i32) {
    const H: [(i32, i32); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

    // ── Build local chunk set ─────────────────────────
    let local: HashSet<(i32, i32)> = (-1..=1i32)
        .flat_map(|dx| (-1..=1i32).map(move |dz| (center_cx + dx, center_cz + dz)))
        .filter(|k| world.chunks.contains_key(k))
        .collect();

    // ── Collect light seeds from external boundaries ──
    // For each local chunk we check the 4 cardinal
    // neighbours that lie outside the local set.
    // We snapshot the sky/block light values on the
    // face of those external chunks that border us;
    // these become extra BFS seeds so that light from
    // the wider world propagates correctly inward.
    let mut sky_seeds: Vec<([i32; 3], u8)> = Vec::new();
    let mut blk_seeds: Vec<([i32; 3], u8)> = Vec::new();

    for &(cx, cz) in &local {
        for (dx, dz) in H {
            let ncx = cx + dx;
            let ncz = cz + dz;
            if local.contains(&(ncx, ncz)) {
                continue;
            }
            let Some(ext) = world.chunks.get(&(ncx, ncz)) else {
                continue;
            };
            // Which face of the external chunk borders us?
            // dx=+1 → ext is to our right → its lx=0 face
            // dx=-1 → ext is to our left  → its lx=N-1 face
            // dz=+1 → ext is to our front → its lz=0 face
            // dz=-1 → ext is behind us    → its lz=N-1 face
            let fx: i32 = if dx == 1 {
                0
            } else if dx == -1 {
                N - 1
            } else {
                -1 // all x
            };
            let fz: i32 = if dz == 1 {
                0
            } else if dz == -1 {
                N - 1
            } else {
                -1 // all z
            };
            let bx = ncx * N;
            let bz = ncz * N;
            for lx in 0..N {
                if fx >= 0 && lx != fx {
                    continue;
                }
                for lz in 0..N {
                    if fz >= 0 && lz != fz {
                        continue;
                    }
                    for ly in 0..N {
                        let i = (lx + lz * N + ly * N * N) as usize;
                        let sl = ext.sky_light[i];
                        if sl > 0 {
                            sky_seeds.push(([bx + lx, ly, bz + lz], sl));
                        }
                        let bl = ext.block_light[i];
                        if bl > 0 {
                            blk_seeds.push(([bx + lx, ly, bz + lz], bl));
                        }
                    }
                }
            }
        }
    }

    // ── Reset local chunks ────────────────────────────
    for &key in &local {
        let c = world.chunks.get_mut(&key).unwrap();
        c.sky_light.fill(0);
        c.block_light.fill(0);
    }

    // ── Sky column pass ───────────────────────────────
    let mut sky_queue = make_buckets();
    for &(cx, cz) in &local {
        let bx = cx * N;
        let bz = cz * N;
        let chunk = world.chunks.get_mut(&(cx, cz)).unwrap();
        for lx in 0..N {
            for lz in 0..N {
                for y in (0..N).rev() {
                    if is_opaque(chunk.get_block(lx, y, lz)) {
                        break;
                    }
                    let i = (lx + lz * N + y * N * N) as usize;
                    chunk.sky_light[i] = 15;
                    sky_queue[15].push([bx + lx, y, bz + lz]);
                }
            }
        }
    }
    // Inject external boundary sky seeds
    for (pos, level) in &sky_seeds {
        sky_queue[*level as usize].push(*pos);
    }

    // ── Sky BFS ───────────────────────────────────────
    for level in (1..=15usize).rev() {
        let seeds = std::mem::take(&mut sky_queue[level]);
        for pos in seeds {
            let [wx, wy, wz] = pos;
            let cx = wx.div_euclid(N);
            let cz = wz.div_euclid(N);
            let lx = wx - cx * N;
            let lz = wz - cz * N;
            let i = (lx + lz * N + wy * N * N) as usize;
            {
                let chunk = match world.chunks.get(&(cx, cz)) {
                    Some(c) => c,
                    None => continue,
                };
                if chunk.sky_light[i] != level as u8 {
                    continue;
                }
            }
            let new_level = level - 1;
            for dir in &DIRS {
                let nx = wx + dir[0];
                let ny = wy + dir[1];
                let nz = wz + dir[2];
                if ny < 0 || ny >= N {
                    continue;
                }
                let ncx = nx.div_euclid(N);
                let ncz = nz.div_euclid(N);
                let nlx = nx - ncx * N;
                let nlz = nz - ncz * N;
                let ni = (nlx + nlz * N + ny * N * N) as usize;
                let chunk = match world.chunks.get_mut(&(ncx, ncz)) {
                    Some(c) => c,
                    None => continue,
                };
                if is_opaque(chunk.get_block(nlx, ny, nlz)) {
                    continue;
                }
                if chunk.sky_light[ni] < new_level as u8 {
                    chunk.sky_light[ni] = new_level as u8;
                    if new_level > 0 {
                        sky_queue[new_level].push([nx, ny, nz]);
                    }
                }
            }
        }
    }

    // ── Block light: seed from emissions + boundary ───
    let mut blk_queue = make_buckets();
    for &(cx, cz) in &local {
        let bx = cx * N;
        let bz = cz * N;
        let chunk = world.chunks.get_mut(&(cx, cz)).unwrap();
        for lx in 0..N {
            for ly in 0..N {
                for lz in 0..N {
                    let bt = chunk.get_block(lx, ly, lz);
                    let e = BLOCK_EMISSION[bt as usize];
                    if e > 0 {
                        let i = (lx + lz * N + ly * N * N) as usize;
                        chunk.block_light[i] = e;
                        blk_queue[e as usize].push([bx + lx, ly, bz + lz]);
                    }
                }
            }
        }
    }
    // Inject external boundary block seeds
    for (pos, level) in &blk_seeds {
        blk_queue[*level as usize].push(*pos);
    }

    // ── Block light BFS ───────────────────────────────
    for level in (1..=15usize).rev() {
        let seeds = std::mem::take(&mut blk_queue[level]);
        for pos in seeds {
            let [wx, wy, wz] = pos;
            let cx = wx.div_euclid(N);
            let cz = wz.div_euclid(N);
            let lx = wx - cx * N;
            let lz = wz - cz * N;
            let i = (lx + lz * N + wy * N * N) as usize;
            {
                let chunk = match world.chunks.get(&(cx, cz)) {
                    Some(c) => c,
                    None => continue,
                };
                if chunk.block_light[i] != level as u8 {
                    continue;
                }
            }
            let new_level = level - 1;
            for dir in &DIRS {
                let nx = wx + dir[0];
                let ny = wy + dir[1];
                let nz = wz + dir[2];
                if ny < 0 || ny >= N {
                    continue;
                }
                let ncx = nx.div_euclid(N);
                let ncz = nz.div_euclid(N);
                let nlx = nx - ncx * N;
                let nlz = nz - ncz * N;
                let ni = (nlx + nlz * N + ny * N * N) as usize;
                let chunk = match world.chunks.get_mut(&(ncx, ncz)) {
                    Some(c) => c,
                    None => continue,
                };
                if is_opaque(chunk.get_block(nlx, ny, nlz)) {
                    continue;
                }
                if chunk.block_light[ni] < new_level as u8 {
                    chunk.block_light[ni] = new_level as u8;
                    if new_level > 0 {
                        blk_queue[new_level].push([nx, ny, nz]);
                    }
                }
            }
        }
    }
}
