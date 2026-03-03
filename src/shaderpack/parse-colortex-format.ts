/**
 * Parse colortex format and clear overrides declared inside shader sources.
 *
 * Shaderpacks can declare buffer format preferences and clear behavior using
 * const declarations at the top of any shader file in the pack:
 *
 *   const int colortex0Format = RGBA16F;
 *   const bool colortex0Clear = false;
 *   const vec4 colortex0ClearColor = vec4(0.0, 0.0, 0.0, 1.0);
 */

export type ColortexFormat = GPUTextureFormat;

/** Maps Optifine/Iris format constant names to WebGPU texture format strings. */
const FORMAT_NAME_MAP: Record<string, GPUTextureFormat> = {
  RGBA8:         "rgba8unorm",
  RGBA8UI:       "rgba8uint",
  RGBA8I:        "rgba8sint",
  RGBA16:        "rgba16uint",
  RGBA16F:       "rgba16float",
  RGBA32F:       "rgba32float",
  RGBA32UI:      "rgba32uint",
  RGBA32I:       "rgba32sint",
  RG8:           "rg8unorm",
  RG16:          "rg16uint",
  RG16F:         "rg16float",
  RG32F:         "rg32float",
  R8:            "r8unorm",
  R16F:          "r16float",
  R32F:          "r32float",
  R11F_G11F_B10F: "rg11b10ufloat",
  RGB10_A2:      "rgb10a2unorm",
};

export interface ColortexConfig {
  format?: GPUTextureFormat;
  clear?: boolean;
  clearColor?: [number, number, number, number];
}

export type ColortexOverrides = Map<number, ColortexConfig>;

/**
 * Scan all provided shader source strings for colortex format/clear declarations
 * and return the merged overrides.
 *
 * If multiple shaders declare conflicting formats for the same buffer, the last
 * one wins (ordering is caller-determined, typically alphabetical stage order).
 */
export function parseColortexOverrides(sources: Iterable<string>): ColortexOverrides {
  const overrides: ColortexOverrides = new Map();

  for (const source of sources) {
    parseColortexFormat(source, overrides);
    parseColortexClear(source, overrides);
    parseColortexClearColor(source, overrides);
  }

  return overrides;
}

function getOrCreate(overrides: ColortexOverrides, index: number): ColortexConfig {
  let cfg = overrides.get(index);
  if (!cfg) { cfg = {}; overrides.set(index, cfg); }
  return cfg;
}

/** Match: const int colortexNFormat = FORMAT_TOKEN; */
function parseColortexFormat(source: string, overrides: ColortexOverrides): void {
  const re = /\bconst\s+int\s+colortex(\d+)Format\s*=\s*(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const idx = Number.parseInt(m[1], 10);
    const token = m[2].toUpperCase();
    const fmt = FORMAT_NAME_MAP[token];
    if (fmt && idx >= 0 && idx <= 7) {
      getOrCreate(overrides, idx).format = fmt;
    }
  }
}

/** Match: const bool colortexNClear = true/false; */
function parseColortexClear(source: string, overrides: ColortexOverrides): void {
  const re = /\bconst\s+bool\s+colortex(\d+)Clear\s*=\s*(true|false)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const idx = Number.parseInt(m[1], 10);
    if (idx >= 0 && idx <= 7) {
      getOrCreate(overrides, idx).clear = m[2] === "true";
    }
  }
}

/** Match: const vec4 colortexNClearColor = vec4(r, g, b, a); */
function parseColortexClearColor(source: string, overrides: ColortexOverrides): void {
  const re = /\bconst\s+vec4\s+colortex(\d+)ClearColor\s*=\s*vec4\s*\(\s*([^)]+)\s*\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const idx = Number.parseInt(m[1], 10);
    if (idx < 0 || idx > 7) continue;
    const parts = m[2].split(",").map((s) => Number.parseFloat(s.trim()));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      getOrCreate(overrides, idx).clearColor = parts as [number, number, number, number];
    }
  }
}
