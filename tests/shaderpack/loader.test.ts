import { describe, expect, test } from "vitest";
import { buildManifestFromVirtualFiles } from "../../src/shaderpack/loader";

describe("buildManifestFromVirtualFiles", () => {
  test("discovers programs and includes", () => {
    const files = new Map<string, string>([
      [
        "shaders/gbuffers_terrain.vsh",
        "#version 330\nvoid main(){}",
      ],
      [
        "shaders/gbuffers_terrain.fsh",
        "/* DRAWBUFFERS:01 */",
      ],
      ["shaders/deferred.fsh", "/* RENDERTARGETS: 0,2 */"],
      [
        "shaders/block.properties",
        "block.1=minecraft:stone",
      ],
      [
        "shaders/shaders.properties",
        "alphaTest.gbuffers_terrain=GREATER 0.1",
      ],
      ["shaders/lib/common.glsl", "#define X 1"],
    ]);

    const manifest = buildManifestFromVirtualFiles(
      files,
      "sample-pack",
    );

    expect(manifest.packName).toBe("sample-pack");
    expect(
      manifest.programs.get("gbuffers_terrain")?.vertex,
    ).toContain("void main");
    expect(
      manifest.programs.get("deferred")?.renderTargets,
    ).toEqual([0, 2]);
    expect(manifest.includes.get("lib/common.glsl")).toBe(
      "#define X 1",
    );
    expect(
      manifest.blockMap.blocks.get("minecraft:stone"),
    ).toBe(1);
    expect(
      manifest.properties.alphaTests.get("gbuffers_terrain")
        ?.ref,
    ).toBe(0.1);
  });
});
