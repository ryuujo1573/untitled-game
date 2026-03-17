import { describe, expect, it } from "vitest";
import { BlockType } from "../../src/environment/world/block";
import { World } from "../../src/environment/world/world";

describe("World snapshots", () => {
  it("roundtrips chunk data", () => {
    const world = new World();
    world.generate(3);

    world.setBlock(1, 1, 1, BlockType.DiamondOre);
    world.setBlock(17, 2, 3, BlockType.CopperOre);

    const snapshot = world.toSnapshot();
    const restored = World.fromSnapshot(snapshot);

    expect(restored.getBlock(1, 1, 1)).toBe(
      BlockType.DiamondOre,
    );
    expect(restored.getBlock(17, 2, 3)).toBe(
      BlockType.CopperOre,
    );
    expect(restored.chunks.size).toBe(world.chunks.size);
    expect(restored.gridSize).toBe(world.gridSize);
  });
});
