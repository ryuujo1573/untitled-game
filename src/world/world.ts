import { Chunk, CHUNK_SIZE } from "./chunk";
import { BlockType } from "./block";

/** Deterministic 3-D hash for ore placement, returns [0, 1). */
function oreRng(wx: number, y: number, wz: number): number {
  let h = (wx * 16807 + y * 48271 + wz * 39119) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}

/**
 * Manages a flat grid of chunks keyed by "cx,cz".
 * For now generates a small fixed-size terrain.
 */
export class World {
  chunks = new Map<string, Chunk>();
  gridSize = 0;

  private key(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(this.key(cx, cz));
  }

  /**
   * Get the block type at world coordinates (wx, wy, wz).
   * Returns Air for unloaded chunks or above the world.
   * Returns Stone for positions below y=0 (bedrock).
   */
  getBlock(wx: number, wy: number, wz: number): BlockType {
    if (wy < 0) return BlockType.Stone;
    if (wy >= CHUNK_SIZE) return BlockType.Air;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const chunk = this.getChunk(cx, cz);
    if (!chunk) return BlockType.Air;
    // Local coords: safe for positive and negative world coordinates.
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    return chunk.getBlock(lx, wy, lz);
  }

  /**
   * Set a block at world coordinates. Returns the affected Chunk
   * so the caller can rebuild its mesh, or null if out of range.
   */
  setBlock(wx: number, wy: number, wz: number, type: BlockType): Chunk | null {
    if (wy < 0 || wy >= CHUNK_SIZE) return null;
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cz = Math.floor(wz / CHUNK_SIZE);
    const chunk = this.getChunk(cx, cz);
    if (!chunk) return null;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    chunk.setBlock(lx, wy, lz, type);
    return chunk;
  }

  /**
   * Generate a `gridSize × gridSize` set of chunks filled with a simple
   * sine-wave heightmap so there are gentle rolling hills.
   */
  generate(gridSize = 4): void {
    this.chunks.clear();
    this.gridSize = gridSize;
    for (let cx = 0; cx < gridSize; cx++) {
      for (let cz = 0; cz < gridSize; cz++) {
        const chunk = new Chunk(cx, cz);

        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const wx = cx * CHUNK_SIZE + lx;
            const wz = cz * CHUNK_SIZE + lz;

            // Simple heightmap: base 6, ±3 from sine/cos waves
            const height = Math.floor(
              6 +
                Math.sin(wx * 0.1) * 2 +
                Math.cos(wz * 0.15) * 2 +
                Math.sin((wx + wz) * 0.07) * 1.5,
            );

            const h = Math.min(height, CHUNK_SIZE - 1);
            for (let y = 0; y <= h; y++) {
              if (y === h) {
                chunk.setBlock(lx, y, lz, BlockType.Grass);
              } else if (y >= h - 2) {
                chunk.setBlock(lx, y, lz, BlockType.Dirt);
              } else {
                // Ore placement: deterministic hash selects block type.
                // Cumulative thresholds → approximate vein densities.
                const r = oreRng(wx, y, wz);
                let bt = BlockType.Stone;
                if (r < 0.005) bt = BlockType.DiamondOre;
                else if (r < 0.013) bt = BlockType.EmeraldOre;
                else if (r < 0.028) bt = BlockType.GoldOre;
                else if (r < 0.043) bt = BlockType.LapisOre;
                else if (r < 0.063) bt = BlockType.RedstoneOre;
                else if (r < 0.093) bt = BlockType.CopperOre;
                else if (r < 0.143) bt = BlockType.IronOre;
                else if (r < 0.223) bt = BlockType.CoalOre;
                chunk.setBlock(lx, y, lz, bt);
              }
            }
          }
        }

        this.chunks.set(this.key(cx, cz), chunk);
      }
    }
  }

  toSnapshot(): { generator: { kind: "default_heightmap"; gridSize: number }; chunks: Array<{ cx: number; cz: number; blocks: Uint8Array }> } {
    return {
      generator: {
        kind: "default_heightmap",
        gridSize: this.gridSize || inferGridSize(this.chunks),
      },
      chunks: Array.from(this.chunks.values()).map((chunk) => chunk.toSnapshot()),
    };
  }

  static fromSnapshot(snapshot: {
    generator: { kind: "default_heightmap"; gridSize: number };
    chunks: Array<{ cx: number; cz: number; blocks: Uint8Array }>;
  }): World {
    const world = new World();
    world.gridSize = snapshot.generator.gridSize;
    for (const chunkSnapshot of snapshot.chunks) {
      const chunk = Chunk.fromSnapshot(chunkSnapshot);
      world.chunks.set(world.key(chunk.cx, chunk.cz), chunk);
    }
    return world;
  }
}

function inferGridSize(chunks: Map<string, Chunk>): number {
  if (chunks.size === 0) return 0;
  let maxCoord = 0;
  for (const chunk of chunks.values()) {
    maxCoord = Math.max(maxCoord, chunk.cx + 1, chunk.cz + 1);
  }
  return maxCoord;
}
