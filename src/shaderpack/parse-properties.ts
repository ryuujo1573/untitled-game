import type { ParsedExpression, ParsedShaderProperties } from "~/shaderpack/types";

function parseBool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function parseExpression(value: string): ParsedExpression | undefined {
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

export function parseShadersProperties(source: string): ParsedShaderProperties {
  const alphaTests = new Map<string, { func: string; ref: number }>();
  const blends = new Map<string, string[]>();
  const flips = new Map<string, boolean>();
  const options = new Map<string, string>();
  const uniforms = new Map<string, ParsedExpression>();
  const variables = new Map<string, ParsedExpression>();
  const warnings: string[] = [];
  let screen: string[] = [];
  let clouds: "off" | "fast" | "fancy" | undefined;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key.startsWith("alphaTest.")) {
      const stage = key.slice("alphaTest.".length);
      const [func = "GREATER", refRaw = "0"] = value.split(/\s+/);
      const ref = Number.parseFloat(refRaw);
      alphaTests.set(stage, { func, ref: Number.isFinite(ref) ? ref : 0 });
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
      if (b === undefined) warnings.push(`Invalid flip value for ${key}: ${value}`);
      else flips.set(stage, b);
      continue;
    }

    if (key.startsWith("option.")) {
      options.set(key.slice("option.".length), value);
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

    if (key.startsWith("uniform.")) {
      const uniformName = key.slice("uniform.".length);
      const expr = parseExpression(`${uniformName}=${value}`);
      if (expr) uniforms.set(uniformName.split(".").slice(-1)[0], expr);
      else warnings.push(`Invalid uniform expression: ${key}=${value}`);
      continue;
    }

    if (key.startsWith("variable.")) {
      const variableName = key.slice("variable.".length);
      const expr = parseExpression(`${variableName}=${value}`);
      if (expr) variables.set(variableName.split(".").slice(-1)[0], expr);
      else warnings.push(`Invalid variable expression: ${key}=${value}`);
      continue;
    }

    warnings.push(`Unsupported shaders.properties key: ${key}`);
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
    warnings,
  };
}
