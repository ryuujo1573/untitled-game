import { describe, expect, test } from "vitest";
import { generateDefaultSkyboxEquirect } from "../../src/skybox";

function rowLuma(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  yNorm: number,
): number {
  const y = Math.max(
    0,
    Math.min(h - 1, Math.floor(yNorm * (h - 1))),
  );
  let sum = 0;
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return sum / w;
}

describe("generateDefaultSkyboxEquirect", () => {
  test("contains a visible horizontal horizon band", () => {
    const w = 512;
    const h = 256;
    const px = generateDefaultSkyboxEquirect(w, h);

    const horizon = rowLuma(px, w, h, 0.5);
    const zenith = rowLuma(px, w, h, 0.1);
    const nadir = rowLuma(px, w, h, 0.9);

    expect(horizon).toBeGreaterThan(zenith + 20);
    expect(horizon).toBeGreaterThan(nadir + 12);
  });

  test("is horizontally wrap-seam continuous", () => {
    const w = 1024;
    const h = 512;
    const px = generateDefaultSkyboxEquirect(w, h);

    let maxEdgeDiff = 0;
    for (let y = 0; y < h; y++) {
      const i0 = (y * w + 0) * 4;
      const i1 = (y * w + (w - 1)) * 4;
      const diff =
        Math.abs(px[i0] - px[i1]) +
        Math.abs(px[i0 + 1] - px[i1 + 1]) +
        Math.abs(px[i0 + 2] - px[i1 + 2]);
      if (diff > maxEdgeDiff) maxEdgeDiff = diff;
    }

    expect(maxEdgeDiff).toBeLessThanOrEqual(3);
  });
});
