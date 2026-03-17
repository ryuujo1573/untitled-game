import { describe, expect, test } from "vitest";
import { parseDrawTargetsFromShaderSource } from "../../src/engine/shaderpack/parse-drawbuffers";

describe("parseDrawTargetsFromShaderSource", () => {
  test("parses DRAWBUFFERS and RENDERTARGETS directives", () => {
    const srcA = "/* DRAWBUFFERS:023 */";
    const srcB = "/* RENDERTARGETS: 0,2,11,15 */";

    expect(parseDrawTargetsFromShaderSource(srcA)).toEqual([
      0, 2, 3,
    ]);
    expect(parseDrawTargetsFromShaderSource(srcB)).toEqual([
      0, 2, 11, 15,
    ]);
  });
});
