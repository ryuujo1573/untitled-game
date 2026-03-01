import { Chunk, CHUNK_SIZE } from "./chunk";
import { BlockType } from "./block";

/**
 * Manages a flat grid of chunks keyed by "cx,cz".
 * For now generates a small fixed-size terrain.
 */
export class World {
  chunks = new Map<string, Chunk>();

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
                chunk.setBlock(lx, y, lz, BlockType.Stone);
              }
            }
          }
        }

        this.chunks.set(this.key(cx, cz), chunk);
      }
    }
  }
}
