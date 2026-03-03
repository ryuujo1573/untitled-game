/**
 * light-engine.ts — Voxel light propagation via BFS.
 *
 * Computes two 0-15 light channels per block for all loaded chunks:
 *
 *   skyLight   — how much sky light reaches this block.
 *                15 = directly under open sky; attenuates by 1 per block
 *                travelled through air; 0 = fully enclosed underground.
 *
 *   blockLight — light emitted by light-source blocks (e.g. RedstoneOre).
 *                Seed value = BLOCK_EMISSION[blockType]; attenuates by 1
 *                per block through air; blocked by solid blocks.
 *
 * Algorithm:
 *   Phase 1 – Sky column pass: for each (wx, wz) column, mark every Air
 *             block above the first solid block as skyLight = 15.
 *   Phase 2 – BFS sky spread: from all skyLight-15 seeds, propagate
 *             horizontally into adjacent air blocks with decreasing level.
 *   Phase 3 – BFS block-light: seed from emissive blocks, propagate
 *             outward through air with decreasing level.
 *
 * Both BFS use a level-bucketed queue (16 lists, one per light level) for
 * O(n) amortised performance.
 */

import type { World } from "./world";
import { CHUNK_SIZE } from "./chunk";
import { BLOCK_EMISSION, isOpaque } from "./block";

const N = CHUNK_SIZE;

/** Six cardinal directions as [dx, dy, dz]. */
const DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [ 1,  0,  0], [-1,  0,  0],
  [ 0,  1,  0], [ 0, -1,  0],
  [ 0,  0,  1], [ 0,  0, -1],
];

/** Create 16 empty buckets for a level-bucketed BFS queue. */
function makeBuckets(): Array<Array<[number, number, number]>> {
  return Array.from({ length: 16 }, () => []);
}

/**
 * Fully recompute sky + block light for all chunks in the world.
 * Call after initial world generation and after any setBlock() call.
 */
export function recomputeWorldLight(world: World): void {
  // ── Reset ────────────────────────────────────────────────────────────────
  for (const chunk of world.chunks.values()) {
    chunk.skyLight.fill(0);
    chunk.blockLight.fill(0);
  }

  // ── Phase 1: Sky column pass ──────────────────────────────────────────────
  // For every (lx, lz) column inside each chunk, walk downward from y=15.
  // Every Air block above the first solid block gets skyLight = 15.
  const skyQueue = makeBuckets();

  for (const chunk of world.chunks.values()) {
    const bx = chunk.cx * N;
    const bz = chunk.cz * N;
    for (let lx = 0; lx < N; lx++) {
      for (let lz = 0; lz < N; lz++) {
        for (let y = N - 1; y >= 0; y--) {
          if (isOpaque(chunk.getBlock(lx, y, lz))) break;
          const i = lx + lz * N + y * N * N;
          chunk.skyLight[i] = 15;
          skyQueue[15].push([bx + lx, y, bz + lz]);
        }
      }
    }
  }

  // ── Phase 2: BFS sky spread ───────────────────────────────────────────────
  // Process buckets from highest (15) to lowest (1).
  for (let level = 15; level >= 1; level--) {
    for (const [wx, wy, wz] of skyQueue[level]) {
      // Stale-check: another path may have already set this higher.
      const cx = Math.floor(wx / N), cz = Math.floor(wz / N);
      const chunk = world.getChunk(cx, cz);
      if (!chunk) continue;
      const lx = wx - cx * N, lz = wz - cz * N;
      if (chunk.skyLight[lx + lz * N + wy * N * N] !== level) continue;

      const newLevel = level - 1;
      for (const [dx, dy, dz] of DIRS) {
        const nx = wx + dx, ny = wy + dy, nz = wz + dz;
        if (ny < 0 || ny >= N) continue; // bedrock / above world

        const ncx = Math.floor(nx / N), ncz = Math.floor(nz / N);
        const nchunk = world.getChunk(ncx, ncz);
        if (!nchunk) continue; // unloaded chunk

        const nlx = nx - ncx * N, nlz = nz - ncz * N;
        if (isOpaque(nchunk.getBlock(nlx, ny, nlz))) continue;

        const ni = nlx + nlz * N + ny * N * N;
        if (nchunk.skyLight[ni] < newLevel) {
          nchunk.skyLight[ni] = newLevel;
          if (newLevel > 0) skyQueue[newLevel].push([nx, ny, nz]);
        }
      }
    }
  }

  // ── Phase 3: Block-light BFS ─────────────────────────────────────────────
  // Seed from every emissive block.
  const blockQueue = makeBuckets();

  for (const chunk of world.chunks.values()) {
    const bx = chunk.cx * N;
    const bz = chunk.cz * N;
    for (let lx = 0; lx < N; lx++) {
      for (let ly = 0; ly < N; ly++) {
        for (let lz = 0; lz < N; lz++) {
          const emission = BLOCK_EMISSION[chunk.getBlock(lx, ly, lz)] ?? 0;
          if (emission > 0) {
            const i = lx + lz * N + ly * N * N;
            chunk.blockLight[i] = emission;
            blockQueue[emission].push([bx + lx, ly, bz + lz]);
          }
        }
      }
    }
  }

  for (let level = 15; level >= 1; level--) {
    for (const [wx, wy, wz] of blockQueue[level]) {
      const cx = Math.floor(wx / N), cz = Math.floor(wz / N);
      const chunk = world.getChunk(cx, cz);
      if (!chunk) continue;
      const lx = wx - cx * N, lz = wz - cz * N;
      if (chunk.blockLight[lx + lz * N + wy * N * N] !== level) continue;

      const newLevel = level - 1;
      for (const [dx, dy, dz] of DIRS) {
        const nx = wx + dx, ny = wy + dy, nz = wz + dz;
        if (ny < 0 || ny >= N) continue;

        const ncx = Math.floor(nx / N), ncz = Math.floor(nz / N);
        const nchunk = world.getChunk(ncx, ncz);
        if (!nchunk) continue;

        const nlx = nx - ncx * N, nlz = nz - ncz * N;
        if (isOpaque(nchunk.getBlock(nlx, ny, nlz))) continue;

        const ni = nlx + nlz * N + ny * N * N;
        if (nchunk.blockLight[ni] < newLevel) {
          nchunk.blockLight[ni] = newLevel;
          if (newLevel > 0) blockQueue[newLevel].push([nx, ny, nz]);
        }
      }
    }
  }
}
