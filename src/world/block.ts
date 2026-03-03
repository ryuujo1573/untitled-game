/** Integer IDs for each block type.  Air = 0 means "empty". */
export enum BlockType {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
  CoalOre = 4,
  IronOre = 5,
  GoldOre = 6,
  DiamondOre = 7,
  EmeraldOre = 8,
  LapisOre = 9,
  RedstoneOre = 10,
  CopperOre = 11,
}

/**
 * Light emission level (0-15) for each block type.
 * Index = BlockType enum value.  0 = non-emissive.
 */
export const BLOCK_EMISSION: ReadonlyArray<number> = [
  0, // Air
  0, // Grass
  0, // Dirt
  0, // Stone
  0, // CoalOre
  0, // IronOre
  0, // GoldOre (faint glow, like Nether gold)
  0, // DiamondOre
  0, // EmeraldOre
  0, // LapisOre
  9, // RedstoneOre — characteristic red glow (level 9, ~torch brightness)
  0, // CopperOre
];

/** Returns true for solid blocks that fully block light propagation. */
export function isOpaque(type: BlockType): boolean {
  return type !== BlockType.Air;
}

/**
 * Maps each block type to the atlas tile index for each face.
 * Face order: [+Y (top), -Y (bottom), +X, -X, +Z, -Z]
 *
 * Atlas tile layout (12 tiles × 16 px wide, 192×16 texture):
 *   0 = grass_top   1 = grass_side   2 = dirt          3 = stone
 *   4 = coal_ore    5 = iron_ore     6 = gold_ore       7 = diamond_ore
 *   8 = emerald_ore 9 = lapis_ore   10 = redstone_ore  11 = copper_ore
 */
export const BlockFaceTile: Record<
  number,
  [number, number, number, number, number, number]
> = {
  [BlockType.Grass]: [0, 2, 1, 1, 1, 1],
  [BlockType.Dirt]: [2, 2, 2, 2, 2, 2],
  [BlockType.Stone]: [3, 3, 3, 3, 3, 3],
  [BlockType.CoalOre]: [4, 4, 4, 4, 4, 4],
  [BlockType.IronOre]: [5, 5, 5, 5, 5, 5],
  [BlockType.GoldOre]: [6, 6, 6, 6, 6, 6],
  [BlockType.DiamondOre]: [7, 7, 7, 7, 7, 7],
  [BlockType.EmeraldOre]: [8, 8, 8, 8, 8, 8],
  [BlockType.LapisOre]: [9, 9, 9, 9, 9, 9],
  [BlockType.RedstoneOre]: [10, 10, 10, 10, 10, 10],
  [BlockType.CopperOre]: [11, 11, 11, 11, 11, 11],
};
