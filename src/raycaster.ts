import { vec3 } from "gl-matrix";
import { World } from "./world/world";
import { BlockType } from "./world/block";

export interface RayHit {
  /** Integer world coordinates of the block that was hit. */
  bx: number;
  by: number;
  bz: number;
  /** Face normal (one of the 6 unit axis directions). */
  nx: number;
  ny: number;
  nz: number;
}

/**
 * DDA (Digital Differential Analyser) voxel ray traversal.
 *
 * Steps the ray one block boundary at a time – always crossing the nearest
 * axis-aligned boundary next – until it either hits a solid block or exceeds
 * `maxDist`.  This is O(n) in the number of blocks traversed and never
 * misses a block no matter how thin it is.
 *
 * Returns null if no solid block is within range.
 */
export function raycast(
  origin: vec3,
  direction: vec3,
  world: World,
  maxDist = 6,
): RayHit | null {
  // Normalise the direction just in case.
  const dir = vec3.normalize(vec3.create(), direction);

  // Current integer block position.
  let bx = Math.floor(origin[0]);
  let by = Math.floor(origin[1]);
  let bz = Math.floor(origin[2]);

  const dx = dir[0];
  const dy = dir[1];
  const dz = dir[2];

  // Step direction per axis (+1 or -1).
  const sx = dx >= 0 ? 1 : -1;
  const sy = dy >= 0 ? 1 : -1;
  const sz = dz >= 0 ? 1 : -1;

  // tDelta: how far along the ray (in t units) we must travel to cross one
  // block boundary on each axis.
  const tDeltaX = Math.abs(1 / dx);
  const tDeltaY = Math.abs(1 / dy);
  const tDeltaZ = Math.abs(1 / dz);

  // tMax: t value at which the ray crosses the next boundary on each axis.
  const tMaxX =
    dx === 0
      ? Infinity
      : (dx > 0 ? bx + 1 - origin[0] : origin[0] - bx) * tDeltaX;
  const tMaxY =
    dy === 0
      ? Infinity
      : (dy > 0 ? by + 1 - origin[1] : origin[1] - by) * tDeltaY;
  const tMaxZ =
    dz === 0
      ? Infinity
      : (dz > 0 ? bz + 1 - origin[2] : origin[2] - bz) * tDeltaZ;

  let tmx = tMaxX;
  let tmy = tMaxY;
  let tmz = tMaxZ;

  // Face normal of the last boundary crossed (updated each step).
  let nx = 0,
    ny = 0,
    nz = 0;

  while (Math.min(tmx, tmy, tmz) < maxDist) {
    // Advance to the nearest boundary.
    if (tmx < tmy && tmx < tmz) {
      bx += sx;
      nx = -sx;
      ny = 0;
      nz = 0;
      tmx += tDeltaX;
    } else if (tmy < tmz) {
      by += sy;
      nx = 0;
      ny = -sy;
      nz = 0;
      tmy += tDeltaY;
    } else {
      bz += sz;
      nx = 0;
      ny = 0;
      nz = -sz;
      tmz += tDeltaZ;
    }

    if (world.getBlock(bx, by, bz) !== BlockType.Air) {
      return { bx, by, bz, nx, ny, nz };
    }
  }

  return null;
}
