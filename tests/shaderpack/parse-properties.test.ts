import { describe, expect, test } from "vitest";
import { parseShadersProperties } from "../../src/shaderpack/parse-properties";

describe("parseShadersProperties", () => {
  test("parses alpha/blend/flip/options/custom uniforms and cloud mode", () => {
    const src = [
      "alphaTest.gbuffers_terrain=GREATER 0.1",
      "blend.gbuffers_water=SRC_ALPHA ONE_MINUS_SRC_ALPHA ONE ONE",
      "flip.composite.colortex4=true",
      "option.SHADOW_QUALITY=1",
      "option.AMBIENT_OCCLUSION=ON",
      "screen=SHADOW_QUALITY AMBIENT_OCCLUSION",
      "variable.float.myVar=sin(frameTimeCounter)",
      "uniform.float.customTime=frameTimeCounter * 0.5",
      "uniform.vec3.customColor=vec3(myVar, 0.0, 1.0)",
      "clouds=fancy",
    ].join("\n");

    const parsed = parseShadersProperties(src);

    expect(
      parsed.alphaTests.get("gbuffers_terrain"),
    ).toEqual({
      func: "GREATER",
      ref: 0.1,
    });
    expect(parsed.blends.get("gbuffers_water")).toEqual([
      "SRC_ALPHA",
      "ONE_MINUS_SRC_ALPHA",
      "ONE",
      "ONE",
    ]);
    expect(parsed.flips.get("composite.colortex4")).toBe(
      true,
    );
    expect(parsed.options.get("SHADOW_QUALITY")).toBe("1");
    expect(parsed.options.get("AMBIENT_OCCLUSION")).toBe(
      "ON",
    );
    expect(parsed.screen).toEqual([
      "SHADOW_QUALITY",
      "AMBIENT_OCCLUSION",
    ]);
    expect(parsed.variables.get("myVar")).toEqual({
      type: "float",
      expr: "sin(frameTimeCounter)",
    });
    expect(parsed.uniforms.get("customTime")).toEqual({
      type: "float",
      expr: "frameTimeCounter * 0.5",
    });
    expect(parsed.uniforms.get("customColor")).toEqual({
      type: "vec3",
      expr: "vec3(myVar, 0.0, 1.0)",
    });
    expect(parsed.clouds).toBe("fancy");
    expect(
      parsed.warnings.some((w) =>
        w.includes(
          "Unsupported shaders.properties key: clouds",
        ),
      ),
    ).toBe(false);
  });
});
