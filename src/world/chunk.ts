import { BlockType, BlockColor } from "./block";

export const CHUNK_SIZE = 16;
const TOTAL = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 4096

/** Flat index from local (x, y, z) coordinates inside a chunk. */
function idx(x: number, y: number, z: number): number {
  return x + z * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
}

// ── Face geometry tables ────────────────────────────────────────
// Each face has 6 vertex offsets (2 triangles) and a light multiplier.
interface FaceDef {
  /** 6 vertices × 3 components = 18 numbers (offsets from block origin). */
  verts: number[];
  /** Brightness multiplier to fake simple directional lighting. */
  light: number;
  /** Neighbor offset [dx, dy, dz] to check for occlusion. */
  neighbor: [number, number, number];
}

const FACES: FaceDef[] = [
  {
    // +Y  (top)
    verts: [0, 1, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0],
    light: 1.0,
    neighbor: [0, 1, 0],
  },
  {
    // -Y  (bottom)
    verts: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1],
    light: 0.5,
    neighbor: [0, -1, 0],
  },
  {
    // +X  (right)
    verts: [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1],
    light: 0.8,
    neighbor: [1, 0, 0],
  },
  {
    // -X  (left)
    verts: [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0],
    light: 0.8,
    neighbor: [-1, 0, 0],
  },
  {
    // +Z  (front)
    verts: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1],
    light: 0.7,
    neighbor: [0, 0, 1],
  },
  {
    // -Z  (back)
    verts: [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    light: 0.7,
    neighbor: [0, 0, -1],
  },
];

export interface ChunkMesh {
  positions: Float32Array;
  colors: Float32Array;
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
  colBuffer: WebGLBuffer | null = null;
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
    const colors: number[] = [];

    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const block = this.getBlock(x, y, z);
          if (block === BlockType.Air) continue;

          const baseColor = BlockColor[block] ?? [1, 0, 1]; // magenta fallback

          for (const face of FACES) {
            const [nx, ny, nz] = face.neighbor;
            if (this.getBlock(x + nx, y + ny, z + nz) !== BlockType.Air)
              continue;

            // Emit 6 vertices (2 triangles)
            for (let v = 0; v < 18; v += 3) {
              positions.push(
                x + face.verts[v],
                y + face.verts[v + 1],
                z + face.verts[v + 2],
              );
              colors.push(
                baseColor[0] * face.light,
                baseColor[1] * face.light,
                baseColor[2] * face.light,
              );
            }
          }
        }
      }
    }

    return {
      positions: new Float32Array(positions),
      colors: new Float32Array(colors),
      vertexCount: positions.length / 3,
    };
  }
}
