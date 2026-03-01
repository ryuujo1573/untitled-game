/**
 * Texture atlas generator.
 *
 * Produces a 64×16 pixel canvas atlas with 4 tiles (16×16 px each) using
 * direct ImageData manipulation for crisp, deterministic pixel-art results.
 *
 * Tile layout (left → right):
 *   0 = grass_top   1 = grass_side   2 = dirt   3 = stone
 *
 * ATLAS_TILES must stay in sync with the constant in voxel_VERTEXSHADER.glsl.
 */

export const ATLAS_TILES = 4;
const T = 16; // tile size in pixels

/** Deterministic hash returning [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761 + y * 1390531 + seed * 72619) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = ((h * 1274126177) | 0) ^ (h >> 16);
  return (h & 0xff) / 255;
}

type RGB = [number, number, number];

// ── Colour palettes ──────────────────────────────────────────────
// Each palette has 5 shades distributed via noise to create natural
// surface variation without obvious tiling.

/** 5-shade grass-green palette (darkest → brightest). */
const GRASS: RGB[] = [
  [55, 94, 16],
  [68, 115, 22],
  [86, 140, 28],
  [102, 164, 36],
  [118, 186, 44],
];

/** 5-shade earthy-brown palette used for dirt and grass-side body. */
const DIRT: RGB[] = [
  [86, 60, 22],
  [106, 76, 34],
  [130, 94, 46],
  [150, 112, 58],
  [168, 130, 72],
];

/** Pick a palette entry from a noise value [0,1). */
function pick5(palette: RGB[], n: number): RGB {
  const i = n < 0.07 ? 0 : n < 0.24 ? 1 : n < 0.76 ? 2 : n < 0.93 ? 3 : 4;
  return palette[i];
}

/**
 * Creates and uploads a 64×16 texture atlas.
 *
 * The UNPACK_FLIP_Y flag is set so canvas row-0 (top) maps to UV v=1
 * (the "top" of a texture quad in OpenGL convention).
 */
export function createAtlasTexture(
  gl: WebGLRenderingContext,
): WebGLTexture | null {
  const W = T * ATLAS_TILES; // 64
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = T;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, T);
  const d = img.data;

  /** Write one pixel at tile column `col`, local coords (px, py). */
  const set = (col: number, px: number, py: number, [r, g, b]: RGB): void => {
    const i = (py * W + col * T + px) * 4;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  };

  // ── Tile 0: Grass Top ────────────────────────────────────────
  // Pure grass surface viewed from above.
  for (let py = 0; py < T; py++)
    for (let px = 0; px < T; px++)
      set(0, px, py, pick5(GRASS, hash(px, py, 1)));

  // ── Tile 1: Grass Side ───────────────────────────────────────
  // Top 2 rows: grass. Rows 2–3: blended transition. Rows 4–15: dirt.
  for (let py = 0; py < T; py++) {
    for (let px = 0; px < T; px++) {
      const n = hash(px, py, 7);
      let rgb: RGB;
      if (py <= 1) {
        rgb = n < 0.38 ? GRASS[1] : GRASS[2];
      } else if (py <= 3) {
        rgb = n < 0.42 ? GRASS[0] : n < 0.66 ? DIRT[2] : DIRT[1];
      } else {
        rgb = pick5(DIRT, n);
      }
      set(1, px, py, rgb);
    }
  }

  // ── Tile 2: Dirt ─────────────────────────────────────────────
  for (let py = 0; py < T; py++)
    for (let px = 0; px < T; px++) set(2, px, py, pick5(DIRT, hash(px, py, 2)));

  // ── Tile 3: Stone ────────────────────────────────────────────
  // Zone-based coarse variation (4×4 pixel zones) + fine noise,
  // then a hand-crafted set of crack pixels overlaid on top.
  for (let py = 0; py < T; py++) {
    for (let px = 0; px < T; px++) {
      const zone = hash(Math.floor(px / 4), Math.floor(py / 4), 91);
      const fine = hash(px, py, 3);
      const g = Math.max(
        90,
        Math.min(148, Math.round(100 + zone * 40 + fine * 14 - 7)),
      );
      set(3, px, py, [g, g, g]);
    }
  }

  // Crack pixels — pixel-art dividing lines between stone zones.
  // prettier-ignore
  const CRACKS: [number, number][] = [
    // Crack A  (top-left diagonal)
    [3, 1], [4, 1], [4, 2], [5, 2], [5, 3], [6, 3], [7, 3], [7, 4],
    // Crack B  (top-right diagonal)
    [10, 0], [11, 0], [12, 0], [12, 1], [12, 2], [13, 2], [14, 2], [14, 3],
    // Crack C  (left mid)
    [0, 8], [1, 8], [1, 9], [2, 9], [2, 10], [3, 10], [3, 11],
    // Crack D  (right mid)
    [13, 7], [14, 7], [15, 7], [15, 8], [15, 9],
    // Crack E  (bottom-left)
    [4, 13], [5, 13], [5, 14], [6, 14], [7, 14], [7, 15],
    // Crack F  (bottom-right)
    [10, 11], [11, 11], [11, 12], [12, 12], [13, 12], [14, 12],
  ];
  for (const [cx, cy] of CRACKS) set(3, cx, cy, [82, 82, 82]);

  ctx.putImageData(img, 0, 0);

  // ── Upload to WebGL ──────────────────────────────────────────
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
