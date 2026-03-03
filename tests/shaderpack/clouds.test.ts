import { describe, expect, test } from "vitest";
import { buildCloudMesh } from "../../src/clouds";

describe("buildCloudMesh", () => {
  test("generates deterministic minecraft-style cloud quads", () => {
    const a = buildCloudMesh({ radiusTiles: 6, tileSize: 12, y: 42, seed: 1337 });
    const b = buildCloudMesh({ radiusTiles: 6, tileSize: 12, y: 42, seed: 1337 });

    expect(a.vertexCount).toBeGreaterThan(0);
    expect(a.positions.length).toBe(a.vertexCount * 3);
    expect(a.uvs.length).toBe(a.vertexCount * 2);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });
});
