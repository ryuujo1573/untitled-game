/** Integer IDs for each block type.  Air = 0 means "empty". */
export enum BlockType {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
}

/**
 * Base color for each block type (RGB 0-1).
 * Side / bottom faces are automatically darkened by the mesh builder.
 */
export const BlockColor: Record<number, [number, number, number]> = {
  [BlockType.Grass]: [0.3, 0.7, 0.2],
  [BlockType.Dirt]: [0.55, 0.36, 0.2],
  [BlockType.Stone]: [0.5, 0.5, 0.5],
};
