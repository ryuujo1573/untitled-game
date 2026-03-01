/** Integer IDs for each block type.  Air = 0 means "empty". */
export enum BlockType {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
}

/**
 * Maps each block type to the atlas tile index for each face.
 * Face order: [+Y (top), -Y (bottom), +X, -X, +Z, -Z]
 *
 * Atlas tile layout (4 tiles × 16 px wide, 64×16 texture):
 *   0 = grass_top   1 = grass_side   2 = dirt   3 = stone
 */
export const BlockFaceTile: Record<
  number,
  [number, number, number, number, number, number]
> = {
  [BlockType.Grass]: [0, 2, 1, 1, 1, 1],
  [BlockType.Dirt]: [2, 2, 2, 2, 2, 2],
  [BlockType.Stone]: [3, 3, 3, 3, 3, 3],
};
