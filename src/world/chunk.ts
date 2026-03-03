import { BlockType, BlockFaceTile } from "./block";

export const CHUNK_SIZE = 16;
const TOTAL = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 4096
const N = CHUNK_SIZE;

/** Flat index from local (x, y, z) coordinates inside a chunk. */
function idx(x: number, y: number, z: number): number {
  return x + z * N + y * N * N;
}

// ── Greedy mesh face configurations ─────────────────────────────
//
// For each of the 6 axis-aligned face directions we define:
//   sliceAxis  – axis perpendicular to the face; we iterate slices along it
//   dim0       – first greedy expansion axis (→ U in local quad UV space)
//   dim1       – second greedy expansion axis (→ V in local quad UV space)
//   neighbor   – block-space offset to the cell that must be Air for the face
//                to be visible
//   normalSign – +1 → face plane is at s+1 on the slice axis; -1 → at s
//   light      – directional light multiplier (simple baked per-face shading)
//
// Face indices match BlockFaceTile order: [+Y, -Y, +X, -X, +Z, -Z]

interface SliceDef {
  faceIndex: number;
  sliceAxis: 0 | 1 | 2;
  dim0: 0 | 1 | 2;
  dim1: 0 | 1 | 2;
  neighbor: [number, number, number];
  normalSign: 1 | -1;
  light: number;
}

// ── Per-face tangent basis ─────────────────────────────────────
//
// Each row: [nx, ny, nz,  tx, ty, tz,  bitangentSign]
// where bitangent B = bitangentSign * cross(N, T).
//
// Derived from the exact corner winding used below for each face case so
// that TBN correctly maps the atlas _n texture to world/view space.
// Face order follows BlockFaceTile: [+Y, -Y, +X, -X, +Z, -Z].
const FACE_TBN: ReadonlyArray<
  readonly [number, number, number, number, number, number, number]
> = [
  [0, 1, 0, 1, 0, 0, -1], // 0: +Y
  [0, -1, 0, 1, 0, 0, 1], // 1: -Y
  [1, 0, 0, 0, 0, 1, -1], // 2: +X
  [-1, 0, 0, 0, 0, -1, -1], // 3: -X
  [0, 0, 1, 1, 0, 0, 1], // 4: +Z
  [0, 0, -1, -1, 0, 0, 1], // 5: -Z
] as const;

const SLICES: SliceDef[] = [
  {
    faceIndex: 0,
    sliceAxis: 1,
    dim0: 0,
    dim1: 2,
    neighbor: [0, 1, 0],
    normalSign: 1,
    light: 1.0,
  }, // +Y
  {
    faceIndex: 1,
    sliceAxis: 1,
    dim0: 0,
    dim1: 2,
    neighbor: [0, -1, 0],
    normalSign: -1,
    light: 0.5,
  }, // -Y
  {
    faceIndex: 2,
    sliceAxis: 0,
    dim0: 2,
    dim1: 1,
    neighbor: [1, 0, 0],
    normalSign: 1,
    light: 0.8,
  }, // +X
  {
    faceIndex: 3,
    sliceAxis: 0,
    dim0: 2,
    dim1: 1,
    neighbor: [-1, 0, 0],
    normalSign: -1,
    light: 0.8,
  }, // -X
  {
    faceIndex: 4,
    sliceAxis: 2,
    dim0: 0,
    dim1: 1,
    neighbor: [0, 0, 1],
    normalSign: 1,
    light: 0.7,
  }, // +Z
  {
    faceIndex: 5,
    sliceAxis: 2,
    dim0: 0,
    dim1: 1,
    neighbor: [0, 0, -1],
    normalSign: -1,
    light: 0.7,
  }, // -Z
];

export interface ChunkMesh {
  positions: Float32Array;
  /**
   * Per-vertex data packed as vec4: [localU, localV, tileIndex, light].
   * localU/V span 0 → (quad width/height) so the vertex shader can tile
   * the atlas sprite across the entire merged quad using fract().
   * `light` is the per-face directional shading factor (0.5 bottom – 1.0 top).
   */
  uvls: Float32Array;
  /** vec3 per vertex – object-space face normal (one of the 6 axis directions). */
  normals: Float32Array;
  /**
   * vec4 per vertex – tangent frame for normal mapping.
   *   xyz = object-space tangent direction (aligned with atlas U axis)
   *   w   = bitangent sign: B = w * cross(N, T)
   */
  tangents: Float32Array;
  /**
   * vec2 per vertex – lightmap values (sky, block), both normalised to [0, 1].
   *   x = skyLight  / 15  — how much sky light reaches this face
   *   y = blockLight / 15 — how much block-source light reaches this face
   */
  lights: Float32Array;
  vertexCount: number;
}

export interface ChunkSnapshot {
  cx: number;
  cz: number;
  blocks: Uint8Array;
}

export class Chunk {
  /** Block IDs stored in a flat array of length 4096. */
  blocks = new Uint8Array(TOTAL);

  /**
   * Per-block sky light level (0-15).
   * 15 = directly under open sky; propagated BFS horizontally.
   * Computed by recomputeWorldLight() in light-engine.ts.
   */
  skyLight = new Uint8Array(TOTAL);

  /**
   * Per-block emissive / torch light level (0-15).
   * Starts from BLOCK_EMISSION seeds and is BFS-propagated outward.
   * Computed by recomputeWorldLight() in light-engine.ts.
   */
  blockLight = new Uint8Array(TOTAL);

  /** Chunk coordinate in world-chunk space (multiply by 16 for world pos). */
  cx: number;
  cz: number;

  // GPU handles (assigned after upload)
  posBuffer: WebGLBuffer | null = null;
  uvBuffer: WebGLBuffer | null = null;
  vertexCount = 0;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
  }

  getBlock(x: number, y: number, z: number): BlockType {
    if (x < 0 || x >= N || y < 0 || y >= N || z < 0 || z >= N)
      return BlockType.Air;
    return this.blocks[idx(x, y, z)] as BlockType;
  }

  setBlock(x: number, y: number, z: number, type: BlockType): void {
    this.blocks[idx(x, y, z)] = type;
  }

  /**
   * Returns the sky light at (x, y, z).
   * Out-of-bounds → 15 (above world = open sky; below/side = no sky).
   */
  getSkyLight(x: number, y: number, z: number): number {
    if (y >= N) return 15; // above world = full sky
    if (x < 0 || x >= N || y < 0 || z < 0 || z >= N) return 0;
    return this.skyLight[idx(x, y, z)];
  }

  /**
   * Returns the block light at (x, y, z).
   * Out-of-bounds → 0 (no emissive source outside loaded chunk).
   */
  getBlockLight(x: number, y: number, z: number): number {
    if (x < 0 || x >= N || y < 0 || y >= N || z < 0 || z >= N) return 0;
    return this.blockLight[idx(x, y, z)];
  }

  toSnapshot(): ChunkSnapshot {
    return {
      cx: this.cx,
      cz: this.cz,
      blocks: new Uint8Array(this.blocks),
    };
  }

  static fromSnapshot(snapshot: ChunkSnapshot): Chunk {
    const chunk = new Chunk(snapshot.cx, snapshot.cz);
    if (snapshot.blocks.length !== TOTAL) {
      throw new Error(
        `Invalid chunk snapshot size: expected ${TOTAL}, got ${snapshot.blocks.length}`,
      );
    }
    chunk.blocks.set(snapshot.blocks);
    return chunk;
  }

  /**
   * Greedy mesh builder (Mikola Lysenko algorithm).
   *
   * For each of the 6 face directions we sweep every 16-block slice
   * perpendicular to the face normal:
   *   1. Build a 16×16 visibility mask: each cell holds an encoded value
   *      combining the atlas tile index and per-face light levels, or −1
   *      if the face is hidden.
   *   2. Greedily merge adjacent cells with the same encoded value into the
   *      largest axis-aligned rectangle, marking merged cells as used.
   *   3. Emit one quad (6 vertices / 2 triangles) per rectangle.
   *
   * Light values are sampled at the air block adjacent to each face (the
   * outward-facing neighbor). This ensures that a cave face lit by a torch
   * in the next block correctly picks up that block's light.
   *
   * Merging only happens when tile index AND light levels are equal, so
   * a gradient of sky light across a cliff face is never collapsed into a
   * single incorrectly-lit quad.
   */
  buildMesh(): ChunkMesh {
    const positions: number[] = [];
    const uvls: number[] = []; // 4 components per vertex: [localU, localV, tileIndex, light]
    const normals: number[] = []; // 3 components per vertex
    const tangents: number[] = []; // 4 components per vertex (xyz + bitangent sign)
    const lights: number[] = []; // 2 components per vertex: [skyL/15, blockL/15]

    // Reusable scratch arrays — allocated once to avoid per-slice GC pressure.
    //
    // mask encoding (Int32Array, value ≥ 0 = visible face):
    //   bits  0- 3: tileIdx  (0-11, 4 bits)
    //   bits  4- 7: skyLight  (0-15, 4 bits) — from air-side neighbor
    //   bits  8-11: blockLight (0-15, 4 bits) — from air-side neighbor
    //   = max encoded value: 11 | (15 << 4) | (15 << 8) = 0xBFF = 3071  (fits in Int16)
    //   -1 = face not visible
    const mask = new Int32Array(N * N);
    const used = new Uint8Array(N * N);
    const coord = [0, 0, 0];

    for (const sl of SLICES) {
      const { faceIndex, sliceAxis, dim0, dim1, neighbor, normalSign, light } =
        sl;

      for (let s = 0; s < N; s++) {
        // ── 1. Build visibility mask for this slice ─────────────
        mask.fill(-1);
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            coord[sliceAxis] = s;
            coord[dim0] = i;
            coord[dim1] = j;
            const block = this.getBlock(coord[0], coord[1], coord[2]);
            if (block === BlockType.Air) continue;

            // Check the block on the outward side — must be Air.
            const nx = coord[0] + neighbor[0];
            const ny = coord[1] + neighbor[1];
            const nz = coord[2] + neighbor[2];
            if (this.getBlock(nx, ny, nz) !== BlockType.Air) continue;

            // Sample light at the air-side neighbor block.
            const skyL = this.getSkyLight(nx, ny, nz);
            const blockL = this.getBlockLight(nx, ny, nz);

            const faceTiles = BlockFaceTile[block] ?? [3, 3, 3, 3, 3, 3];
            const tileIdx = faceTiles[faceIndex];
            mask[i + j * N] = tileIdx | (skyL << 4) | (blockL << 8);
          }
        }

        // ── 2 & 3. Greedy sweep → emit merged quads ─────────────
        used.fill(0);
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            if (used[i + j * N]) continue;
            const encoded = mask[i + j * N];
            if (encoded < 0) continue;

            // Grow width along dim0 (i direction).
            let w = 1;
            while (
              i + w < N &&
              !used[i + w + j * N] &&
              mask[i + w + j * N] === encoded
            )
              w++;

            // Grow height along dim1 (j direction).
            let h = 1;
            expand: while (j + h < N) {
              for (let k = i; k < i + w; k++) {
                if (used[k + (j + h) * N] || mask[k + (j + h) * N] !== encoded)
                  break expand;
              }
              h++;
            }

            // Mark merged cells as used.
            for (let dj = 0; dj < h; dj++)
              for (let di = 0; di < w; di++) used[i + di + (j + dj) * N] = 1;

            // Decode tile and light from the encoded mask value.
            const tileIdx = encoded & 0xf;
            const skyL = (encoded >> 4) & 0xf;
            const blockL = (encoded >> 8) & 0xf;

            // ── Emit the merged quad ──────────────────────────────
            // Face plane sits at sv on the slice axis.
            const sv = normalSign > 0 ? s + 1 : s;

            // Build a position from (slicePos, dim0Pos, dim1Pos).
            type V3 = [number, number, number];
            const p = (sa: number, da: number, db: number): V3 => {
              const c: V3 = [0, 0, 0];
              c[sliceAxis] = sa;
              c[dim0] = da;
              c[dim1] = db;
              return c;
            };

            // Four corners with CCW winding (viewed from outside the face).
            // UV pattern A (U→dim0, V→dim1): faces +Y, +X
            // UV pattern B (U→dim0, V→dim1, different winding): faces -Y, +Z
            // Reversed-U variants for -X and -Z preserve correct texture orientation.
            type Corner = [V3, [number, number]];
            let corners: Corner[];
            switch (faceIndex) {
              case 0: // +Y  dim0=X(i), dim1=Z(j) — pattern A
                corners = [
                  [p(sv, i, j), [0, 0]],
                  [p(sv, i, j + h), [0, h]],
                  [p(sv, i + w, j + h), [w, h]],
                  [p(sv, i + w, j), [w, 0]],
                ];
                break;
              case 1: // -Y  dim0=X(i), dim1=Z(j) — pattern B
                corners = [
                  [p(sv, i, j), [0, 0]],
                  [p(sv, i + w, j), [w, 0]],
                  [p(sv, i + w, j + h), [w, h]],
                  [p(sv, i, j + h), [0, h]],
                ];
                break;
              case 2: // +X  dim0=Z(i), dim1=Y(j) — pattern A
                corners = [
                  [p(sv, i, j), [0, 0]],
                  [p(sv, i, j + h), [0, h]],
                  [p(sv, i + w, j + h), [w, h]],
                  [p(sv, i + w, j), [w, 0]],
                ];
                break;
              case 3: // -X  dim0=Z(i), dim1=Y(j) — reversed U along dim0
                corners = [
                  [p(sv, i + w, j), [0, 0]],
                  [p(sv, i + w, j + h), [0, h]],
                  [p(sv, i, j + h), [w, h]],
                  [p(sv, i, j), [w, 0]],
                ];
                break;
              case 4: // +Z  dim0=X(i), dim1=Y(j) — pattern B
                corners = [
                  [p(sv, i, j), [0, 0]],
                  [p(sv, i + w, j), [w, 0]],
                  [p(sv, i + w, j + h), [w, h]],
                  [p(sv, i, j + h), [0, h]],
                ];
                break;
              default: // -Z  dim0=X(i), dim1=Y(j) — reversed U along dim0
                corners = [
                  [p(sv, i + w, j), [0, 0]],
                  [p(sv, i, j), [w, 0]],
                  [p(sv, i, j + h), [w, h]],
                  [p(sv, i + w, j + h), [0, h]],
                ];
                break;
            }

            // Two triangles: (0,1,2) and (0,2,3).
            const tbn = FACE_TBN[faceIndex];
            const skyN = skyL / 15;
            const blockN = blockL / 15;
            for (const vi of [0, 1, 2, 0, 2, 3]) {
              const [pos, uv] = corners[vi];
              positions.push(pos[0], pos[1], pos[2]);
              uvls.push(uv[0], uv[1], tileIdx, light);
              normals.push(tbn[0], tbn[1], tbn[2]);
              tangents.push(tbn[3], tbn[4], tbn[5], tbn[6]);
              lights.push(skyN, blockN);
            }
          }
        }
      }
    }

    return {
      positions: new Float32Array(positions),
      uvls: new Float32Array(uvls),
      normals: new Float32Array(normals),
      tangents: new Float32Array(tangents),
      lights: new Float32Array(lights),
      vertexCount: positions.length / 3,
    };
  }
}
