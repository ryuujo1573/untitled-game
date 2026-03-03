import type { PlatformMacro, ShaderStageName } from "~/shaderpack/types";

interface PreprocessInput {
  source: string;
  stage: ShaderStageName;
  includeMap: Map<string, string>;
  options: Map<string, string>;
  platform: PlatformMacro;
}

interface PreprocessOutput {
  code: string;
  warnings: string[];
}

const STAGE_DEFINE: Record<ShaderStageName, string> = {
  shadow: "MC_RENDER_STAGE_SHADOW",
  shadow_solid: "MC_RENDER_STAGE_SHADOW",
  shadow_cutout: "MC_RENDER_STAGE_SHADOW",
  gbuffers_clouds: "MC_RENDER_STAGE_SKY",
  gbuffers_terrain: "MC_RENDER_STAGE_TERRAIN_SOLID",
  deferred: "MC_RENDER_STAGE_NONE",
  deferred1: "MC_RENDER_STAGE_NONE",
  deferred2: "MC_RENDER_STAGE_NONE",
  deferred3: "MC_RENDER_STAGE_NONE",
  composite: "MC_RENDER_STAGE_NONE",
  composite1: "MC_RENDER_STAGE_NONE",
  composite2: "MC_RENDER_STAGE_NONE",
  composite3: "MC_RENDER_STAGE_NONE",
  final: "MC_RENDER_STAGE_NONE",
};

function resolveIncludes(
  source: string,
  includeMap: Map<string, string>,
  warnings: string[],
  stack: string[] = [],
): string {
  return source.replace(/^\s*#include\s+"([^"]+)"\s*$/gm, (_full, relPath: string) => {
    if (stack.includes(relPath)) {
      warnings.push(`Include cycle detected: ${[...stack, relPath].join(" -> ")}`);
      return "";
    }
    const included = includeMap.get(relPath);
    if (included === undefined) {
      warnings.push(`Missing include: ${relPath}`);
      return "";
    }
    return resolveIncludes(included, includeMap, warnings, [...stack, relPath]);
  });
}

function platformDefine(platform: PlatformMacro): string {
  if (platform === "windows") return "#define MC_OS_WINDOWS";
  if (platform === "mac") return "#define MC_OS_MAC";
  return "#define MC_OS_LINUX";
}

export function preprocessShader(input: PreprocessInput): PreprocessOutput {
  const warnings: string[] = [];

  const versionMatch = input.source.match(/^\s*#version\s+.+$/m);
  const versionLine = versionMatch?.[0]?.trim() ?? "#version 330";

  let rest = input.source;
  if (versionMatch) {
    rest = rest.replace(versionMatch[0], "");
  }

  rest = resolveIncludes(rest, input.includeMap, warnings);

  const macroLines: string[] = [
    "#define ROUGHLY_A_3D_GAME 1",
    "#define ENGINE_VERSION 1",
    "#define MC_BACKEND_WEBGPU 1",
    "#define MC_RENDER_STAGE_TERRAIN_SOLID 5",
    "#define MC_RENDER_STAGE_SKY 1",
    "#define MC_RENDER_STAGE_SHADOW 9",
    "#define MC_RENDER_STAGE_NONE 0",
    platformDefine(input.platform),
    `#define ${STAGE_DEFINE[input.stage]} ${STAGE_DEFINE[input.stage] === "MC_RENDER_STAGE_TERRAIN_SOLID" ? "5" : STAGE_DEFINE[input.stage] === "MC_RENDER_STAGE_SHADOW" ? "9" : STAGE_DEFINE[input.stage] === "MC_RENDER_STAGE_SKY" ? "1" : "0"}`,
  ];

  for (const [k, v] of input.options) {
    macroLines.push(`#define ${k} ${v}`);
  }

  const code = [versionLine, ...macroLines, rest.trimStart()].join("\n");
  return { code, warnings };
}
