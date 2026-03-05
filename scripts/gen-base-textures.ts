/**
 * Generates grass_block_top.png, grass_block_side.png, dirt.png, stone.png
 * into src/assets/textures/block/ using the same deterministic pixel-art
 * algorithms that atlas.ts previously ran at browser startup.
 *
 * Run once:  bun scripts/gen-base-textures.ts
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { PNG } from "pngjs";

const T = 16;
type RGB = [number, number, number];

/** Deterministic hash returning [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761 + y * 1390531 + seed * 72619) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = ((h * 1274126177) | 0) ^ (h >> 16);
  return (h & 0xff) / 255;
}

const GRASS: RGB[] = [
  [55, 94, 16],
  [68, 115, 22],
  [86, 140, 28],
  [102, 164, 36],
  [118, 186, 44],
];
const DIRT: RGB[] = [
  [86, 60, 22],
  [106, 76, 34],
  [130, 94, 46],
  [150, 112, 58],
  [168, 130, 72],
];

function pick5(palette: RGB[], n: number): RGB {
  const i =
    n < 0.07
      ? 0
      : n < 0.24
        ? 1
        : n < 0.76
          ? 2
          : n < 0.93
            ? 3
            : 4;
  return palette[i];
}

function make(
  drawFn: (px: number, py: number) => RGB,
): PNG {
  const png = new PNG({ width: T, height: T });
  for (let py = 0; py < T; py++) {
    for (let px = 0; px < T; px++) {
      const [r, g, b] = drawFn(px, py);
      const i = (py * T + px) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

function save(png: PNG, name: string) {
  const dest = join(
    import.meta.dir,
    "../src/assets/textures/block",
    name,
  );
  writeFileSync(dest, PNG.sync.write(png));
  console.log("✓  " + name);
}

// ── grass_block_top.png ──────────────────────────────────────────
save(
  make((px, py) => pick5(GRASS, hash(px, py, 1))),
  "grass_block_top.png",
);

// ── grass_block_side.png ─────────────────────────────────────────
save(
  make((px, py) => {
    const n = hash(px, py, 7);
    if (py <= 1) return n < 0.38 ? GRASS[1] : GRASS[2];
    if (py <= 3)
      return n < 0.42
        ? GRASS[0]
        : n < 0.66
          ? DIRT[2]
          : DIRT[1];
    return pick5(DIRT, n);
  }),
  "grass_block_side.png",
);

// ── dirt.png ─────────────────────────────────────────────────────
save(
  make((px, py) => pick5(DIRT, hash(px, py, 2))),
  "dirt.png",
);

// ── stone.png  (zone noise + crack pixels) ───────────────────────
const stonePng = make((px, py) => {
  const zone = hash(
    Math.floor(px / 4),
    Math.floor(py / 4),
    91,
  );
  const fine = hash(px, py, 3);
  const g = Math.max(
    90,
    Math.min(
      148,
      Math.round(100 + zone * 40 + fine * 14 - 7),
    ),
  );
  return [g, g, g];
});
const CRACKS: [number, number][] = [
  [3, 1],
  [4, 1],
  [4, 2],
  [5, 2],
  [5, 3],
  [6, 3],
  [7, 3],
  [7, 4],
  [10, 0],
  [11, 0],
  [12, 0],
  [12, 1],
  [12, 2],
  [13, 2],
  [14, 2],
  [14, 3],
  [0, 8],
  [1, 8],
  [1, 9],
  [2, 9],
  [2, 10],
  [3, 10],
  [3, 11],
  [13, 7],
  [14, 7],
  [15, 7],
  [15, 8],
  [15, 9],
  [4, 13],
  [5, 13],
  [5, 14],
  [6, 14],
  [7, 14],
  [7, 15],
  [10, 11],
  [11, 11],
  [11, 12],
  [12, 12],
  [13, 12],
  [14, 12],
];
for (const [cx, cy] of CRACKS) {
  const i = (cy * T + cx) * 4;
  stonePng.data[i] = 82;
  stonePng.data[i + 1] = 82;
  stonePng.data[i + 2] = 82;
}
save(stonePng, "stone.png");
