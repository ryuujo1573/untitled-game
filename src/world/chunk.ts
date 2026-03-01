import { BlockType, BlockFaceTile } from "./block";

export const CHUNK_SIZE = 16;
const TOTAL = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 4096

/** Flat index from local (x, y, z) coordinates inside a chunk. */
function idx(x: number, y: number, z: number): number {
  return x + z * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
}

/** Number of tiles in one row of the texture atlas. */
const ATLAS_TILES = 4;

// ── UV patterns ─────────────────────────────────────────────────
// Each pattern defines local UVs for 6 vertices (2 triangles).
//
// Pattern A – the first planar axis becomes U, second becomes V.
//   Correct for:  +Y (U=X V=Z),  +X (U=Z V=Y),  -X (U=1-Z V=Y)
// Pattern B – horizontal world axis becomes U, vertical becomes V.
//   Correct for:  -Y (U=X V=Z),  +Z (U=X V=Y),  -Z (U=1-X V=Y)
const UV_A = [0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0];
const UV_B = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];

// ── Face geometry tables ────────────────────────────────────────
// Each face has 6 vertex offsets (2 triangles), per-face UVs, and a light multiplier.
interface FaceDef {
  /** 6 vertices × 3 components = 18 numbers (offsets from block origin). */
  verts: number[];
  /** 6 vertices × 2 UV components = 12 numbers (local quad UVs). */
  uvs: number[];
  /** Brightness multiplier to fake simple directional lighting. */
  light: number;
  /** Neighbor offset [dx, dy, dz] to check for occlusion. */
  neighbor: [number, number, number];
}

const FACES: FaceDef[] = [
  {
    // +Y  (top)  – U=X V=Z → Pattern A
    verts: [0, 1, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0],
    uvs: UV_A,
    light: 1.0,
    neighbor: [0, 1, 0],
  },
  {
    // -Y  (bottom)  – U=X V=Z → Pattern B
    verts: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1],
    uvs: UV_B,
    light: 0.5,
    neighbor: [0, -1, 0],
  },
  {
    // +X  (right)  – U=Z V=Y → Pattern A
    verts: [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1],
    uvs: UV_A,
    light: 0.8,
    neighbor: [1, 0, 0],
  },
  {
    // -X  (left)  – U=1-Z V=Y (mirrored) → Pattern A
    verts: [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0],
    uvs: UV_A,
    light: 0.8,
    neighbor: [-1, 0, 0],
  },
  {
    // +Z  (front)  – U=X V=Y → Pattern B
    verts: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1],
    uvs: UV_B,
    light: 0.7,
    neighbor: [0, 0, 1],
  },
  {
    // -Z  (back)  – U=1-X V=Y (mirrored) → Pattern B
    verts: [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    uvs: UV_B,
    light: 0.7,
    neighbor: [0, 0, -1],
  },
];

export interface ChunkMesh {
  positions: Float32Array;
  /** UV coords + light factor packed as vec3: [u, v, light] per vertex */
  uvls: Float32Array;
  vertexCount: number;
}

export class Chunk {
  /** Block IDs stored in a flat array of length 4096. */
  blocks = new Uint8Array(TOTAL);

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
    if (
      x < 0 ||
      x >= CHUNK_SIZE ||
      y < 0 ||
      y >= CHUNK_SIZE ||
      z < 0 ||
      z >= CHUNK_SIZE
    )
      return BlockType.Air; // treat out-of-bounds as air
    return this.blocks[idx(x, y, z)] as BlockType;
  }

  setBlock(x: number, y: number, z: number, type: BlockType): void {
    this.blocks[idx(x, y, z)] = type;
  }

  /**
   * Build a renderable mesh by iterating every non-Air block and emitting
   * quads only for faces adjacent to Air (hidden-surface removal).
   */
  buildMesh(): ChunkMesh {
    const positions: number[] = [];
    const uvls: number[] = [];

    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const block = this.getBlock(x, y, z);
          if (block === BlockType.Air) continue;

          // Fall back to stone tile indices if block type is unknown.
          const faceTiles = BlockFaceTile[block] ?? [3, 3, 3, 3, 3, 3];

          for (let faceIdx = 0; faceIdx < FACES.length; faceIdx++) {
            const face = FACES[faceIdx];
            const [nx, ny, nz] = face.neighbor;
            if (this.getBlock(x + nx, y + ny, z + nz) !== BlockType.Air)
              continue;

            const tileU = faceTiles[faceIdx] / ATLAS_TILES;
            const tileW = 1 / ATLAS_TILES;

            // Emit 6 vertices (2 triangles)
            for (let v = 0; v < 6; v++) {
              positions.push(
                x + face.verts[v * 3],
                y + face.verts[v * 3 + 1],
                z + face.verts[v * 3 + 2],
              );
              uvls.push(
                tileU + face.uvs[v * 2] * tileW,
                face.uvs[v * 2 + 1],
                face.light,
              );
            }
          }
        }
      }
    }

    return {
      positions: new Float32Array(positions),
      uvls: new Float32Array(uvls),
      vertexCount: positions.length / 3,
    };
  }
}
