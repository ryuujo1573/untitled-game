import type {
  ParsedExpression,
  ParsedShaderProperties,
  ShadowConfig,
} from "~/engine/shaderpack/types";

function parseBool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function parseFloat(value: string): number | undefined {
  const n = Number.parseFloat(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

function parseInt(value: string): number | undefined {
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseExpression(
  value: string,
): ParsedExpression | undefined {
  const eq = value.indexOf("=");
  if (eq < 0) return undefined;
  const lhs = value.slice(0, eq).trim();
  const rhs = value.slice(eq + 1).trim();
  const segs = lhs.split(".");
  if (segs.length !== 2) return undefined;
  return {
    type: segs[0],
    expr: rhs,
  };
}

function defaultShadowConfig(): ShadowConfig {
  return {
    enabled: true,
    mapResolution: 1024,
    distance: 128,
    distanceRenderMul: 1.0,
    intervalSize: 2.0,
    terrain: true,
    translucent: true,
    entities: true,
  };
}

export function parseShadersProperties(
  source: string,
): ParsedShaderProperties {
  const alphaTests = new Map<
    string,
    { func: string; ref: number }
  >();
  const blends = new Map<string, string[]>();
  const flips = new Map<string, boolean>();
  const options = new Map<string, string>();
  const uniforms = new Map<string, ParsedExpression>();
  const variables = new Map<string, ParsedExpression>();
  const customTextures = new Map<string, string>();
  const warnings: string[] = [];
  let screen: string[] = [];
  let clouds: "off" | "fast" | "fancy" | undefined;
  const shadow = defaultShadowConfig();
  let sunPathRotation = 0;
  let sun = true;
  let moon = true;
  let oldLighting = false;
  let underwaterOverlay = false;
  let vignette = false;
  let wetnessHalflife = 600;
  let drynessHalflife = 200;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key.startsWith("alphaTest.")) {
      const stage = key.slice("alphaTest.".length);
      const [func = "GREATER", refRaw = "0"] =
        value.split(/\s+/);
      const ref = Number.parseFloat(refRaw);
      alphaTests.set(stage, {
        func,
        ref: Number.isFinite(ref) ? ref : 0,
      });
      continue;
    }

    if (key.startsWith("blend.")) {
      const stage = key.slice("blend.".length);
      blends.set(stage, value.split(/\s+/).filter(Boolean));
      continue;
    }

    if (key.startsWith("flip.")) {
      const stage = key.slice("flip.".length);
      const b = parseBool(value);
      if (b === undefined)
        warnings.push(
          `Invalid flip value for ${key}: ${value}`,
        );
      else flips.set(stage, b);
      continue;
    }

    if (key.startsWith("option.")) {
      options.set(key.slice("option.".length), value);
      continue;
    }

    if (key.startsWith("texture.")) {
      customTextures.set(
        key.slice("texture.".length),
        value,
      );
      continue;
    }

    if (key === "screen") {
      screen = value.split(/\s+/).filter(Boolean);
      continue;
    }

    if (key === "clouds") {
      const m = value.trim().toLowerCase();
      if (m === "off" || m === "fast" || m === "fancy") {
        clouds = m;
      } else {
        warnings.push(`Invalid clouds mode: ${value}`);
      }
      continue;
    }

    // Shadow configuration
    if (
      key === "shadowMapResolution" ||
      key === "shadow.resolution"
    ) {
      const v = parseInt(value);
      if (v !== undefined) shadow.mapResolution = v;
      continue;
    }
    if (key === "shadowDistance") {
      const v = parseFloat(value);
      if (v !== undefined) shadow.distance = v;
      continue;
    }
    if (key === "shadowDistanceRenderMul") {
      const v = parseFloat(value);
      if (v !== undefined) shadow.distanceRenderMul = v;
      continue;
    }
    if (key === "shadowIntervalSize") {
      const v = parseFloat(value);
      if (v !== undefined) shadow.intervalSize = v;
      continue;
    }
    if (key === "shadow.enabled") {
      const b = parseBool(value);
      if (b !== undefined) shadow.enabled = b;
      continue;
    }
    if (
      key === "shadowTerrain" ||
      key === "shadow.terrain"
    ) {
      const b = parseBool(value);
      if (b !== undefined) shadow.terrain = b;
      continue;
    }
    if (
      key === "shadowTranslucent" ||
      key === "shadow.translucent"
    ) {
      const b = parseBool(value);
      if (b !== undefined) shadow.translucent = b;
      continue;
    }
    if (
      key === "shadowEntities" ||
      key === "shadow.entities"
    ) {
      const b = parseBool(value);
      if (b !== undefined) shadow.entities = b;
      continue;
    }

    // Sun/Moon/Sky
    if (key === "sunPathRotation") {
      const v = parseFloat(value);
      if (v !== undefined) sunPathRotation = v;
      continue;
    }
    if (key === "sun") {
      const b = parseBool(value);
      if (b !== undefined) sun = b;
      continue;
    }
    if (key === "moon") {
      const b = parseBool(value);
      if (b !== undefined) moon = b;
      continue;
    }

    // Misc toggles
    if (key === "oldLighting") {
      const b = parseBool(value);
      if (b !== undefined) oldLighting = b;
      continue;
    }
    if (key === "underwaterOverlay") {
      const b = parseBool(value);
      if (b !== undefined) underwaterOverlay = b;
      continue;
    }
    if (key === "vignette") {
      const b = parseBool(value);
      if (b !== undefined) vignette = b;
      continue;
    }

    // Weather timing
    if (key === "wetnessHalflife") {
      const v = parseFloat(value);
      if (v !== undefined) wetnessHalflife = v;
      continue;
    }
    if (key === "drynessHalflife") {
      const v = parseFloat(value);
      if (v !== undefined) drynessHalflife = v;
      continue;
    }

    if (key.startsWith("uniform.")) {
      const uniformName = key.slice("uniform.".length);
      const expr = parseExpression(
        `${uniformName}=${value}`,
      );
      if (expr)
        uniforms.set(
          uniformName.split(".").slice(-1)[0],
          expr,
        );
      else
        warnings.push(
          `Invalid uniform expression: ${key}=${value}`,
        );
      continue;
    }

    if (key.startsWith("variable.")) {
      const variableName = key.slice("variable.".length);
      const expr = parseExpression(
        `${variableName}=${value}`,
      );
      if (expr)
        variables.set(
          variableName.split(".").slice(-1)[0],
          expr,
        );
      else
        warnings.push(
          `Invalid variable expression: ${key}=${value}`,
        );
      continue;
    }

    // Silently ignore known but unhandled keys (screen.*, sliders.*, etc.)
    if (
      key.startsWith("screen.") ||
      key.startsWith("sliders.") ||
      key.startsWith("profile.") ||
      key === "dynamicHandLight" ||
      key === "oldHandLight" ||
      key === "separateAo"
    ) {
      continue;
    }

    warnings.push(
      `Unsupported shaders.properties key: ${key}`,
    );
  }

  return {
    alphaTests,
    blends,
    flips,
    options,
    screen,
    uniforms,
    variables,
    clouds,
    shadow,
    sunPathRotation,
    sun,
    moon,
    oldLighting,
    underwaterOverlay,
    vignette,
    wetnessHalflife,
    drynessHalflife,
    customTextures,
    warnings,
  };
}
