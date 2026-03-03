import { describe, expect, test } from "vitest";
import { preprocessShader } from "../../src/shaderpack/preprocess";

describe("preprocessShader", () => {
  test("keeps #version first, injects macros, resolves includes", () => {
    const main = [
      "#version 330",
      "#include \"lib/common.glsl\"",
      "void main() { gl_Position = vec4(UTIL, 1.0); }",
    ].join("\n");

    const out = preprocessShader({
      source: main,
      stage: "gbuffers_terrain",
      options: new Map([["SHADOW_QUALITY", "1"]]),
      includeMap: new Map([["lib/common.glsl", "#define UTIL vec3(0.0)"]]),
      platform: "mac",
    });

    const lines = out.code.split("\n");
    expect(lines[0]).toBe("#version 330");
    expect(out.code.includes("#define ROUGHLY_A_3D_GAME 1")).toBe(true);
    expect(out.code.includes("#define MC_OS_MAC")).toBe(true);
    expect(out.code.includes("#define MC_RENDER_STAGE_TERRAIN_SOLID 5")).toBe(true);
    expect(out.code.includes("#define SHADOW_QUALITY 1")).toBe(true);
    expect(out.code.includes("#define UTIL vec3(0.0)")).toBe(true);
  });

  test("detects include cycles", () => {
    const out = preprocessShader({
      source: '#include "a.glsl"',
      stage: "final",
      options: new Map(),
      includeMap: new Map([
        ["a.glsl", '#include "b.glsl"'],
        ["b.glsl", '#include "a.glsl"'],
      ]),
      platform: "linux",
    });

    expect(out.warnings.some((w) => w.includes("Include cycle detected"))).toBe(true);
  });
});
