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
