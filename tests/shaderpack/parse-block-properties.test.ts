import { describe, expect, test } from "vitest";
import { parseBlockProperties } from "../../src/engine/shaderpack/parse-block-properties";

describe("parseBlockProperties", () => {
  test("parses block id mapping and ignores malformed rows", () => {
    const src = [
      "block.1=minecraft:grass_block minecraft:dirt",
      "block.2=minecraft:stone",
      "block.bad=ignore",
      "not_block.3=x",
    ].join("\n");

    const parsed = parseBlockProperties(src);

    expect(parsed.blocks.get("minecraft:grass_block")).toBe(
      1,
    );
    expect(parsed.blocks.get("minecraft:dirt")).toBe(1);
    expect(parsed.blocks.get("minecraft:stone")).toBe(2);
    expect(parsed.warnings.length).toBe(1);
  });
});
