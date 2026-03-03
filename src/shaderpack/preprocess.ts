import type {
  PlatformMacro,
  ShaderStageName,
} from "~/shaderpack/types";

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
  // Shadow
  shadow: "MC_RENDER_STAGE_SHADOW",
  shadow_solid: "MC_RENDER_STAGE_SHADOW",
  shadow_cutout: "MC_RENDER_STAGE_SHADOW",
  // GBuffers
  gbuffers_basic: "MC_RENDER_STAGE_NONE",
  gbuffers_textured: "MC_RENDER_STAGE_NONE",
  gbuffers_textured_lit: "MC_RENDER_STAGE_NONE",
  gbuffers_terrain: "MC_RENDER_STAGE_TERRAIN_SOLID",
  gbuffers_water: "MC_RENDER_STAGE_WATER",
  gbuffers_weather: "MC_RENDER_STAGE_NONE",
  gbuffers_entities: "MC_RENDER_STAGE_NONE",
  gbuffers_hand: "MC_RENDER_STAGE_NONE",
  gbuffers_hand_water: "MC_RENDER_STAGE_NONE",
  gbuffers_armor_glint: "MC_RENDER_STAGE_NONE",
  gbuffers_damagedblock: "MC_RENDER_STAGE_NONE",
  gbuffers_skybasic: "MC_RENDER_STAGE_SKY",
  gbuffers_skytextured: "MC_RENDER_STAGE_SKY",
  gbuffers_clouds: "MC_RENDER_STAGE_SKY",
  // Deferred
  deferred: "MC_RENDER_STAGE_NONE",
  deferred1: "MC_RENDER_STAGE_NONE",
  deferred2: "MC_RENDER_STAGE_NONE",
  deferred3: "MC_RENDER_STAGE_NONE",
  deferred4: "MC_RENDER_STAGE_NONE",
  deferred5: "MC_RENDER_STAGE_NONE",
  deferred6: "MC_RENDER_STAGE_NONE",
  deferred7: "MC_RENDER_STAGE_NONE",
  deferred8: "MC_RENDER_STAGE_NONE",
  deferred9: "MC_RENDER_STAGE_NONE",
  deferred10: "MC_RENDER_STAGE_NONE",
  // Composite
  composite: "MC_RENDER_STAGE_NONE",
  composite1: "MC_RENDER_STAGE_NONE",
  composite2: "MC_RENDER_STAGE_NONE",
  composite3: "MC_RENDER_STAGE_NONE",
  composite4: "MC_RENDER_STAGE_NONE",
  composite5: "MC_RENDER_STAGE_NONE",
  composite6: "MC_RENDER_STAGE_NONE",
  composite7: "MC_RENDER_STAGE_NONE",
  composite8: "MC_RENDER_STAGE_NONE",
  // Final
  final: "MC_RENDER_STAGE_NONE",
};

function resolveIncludes(
  source: string,
  includeMap: Map<string, string>,
  warnings: string[],
  stack: string[] = [],
): string {
  return source.replace(
    /^\s*#include\s+"([^"]+)"\s*$/gm,
    (_full, relPath: string) => {
      if (stack.includes(relPath)) {
        warnings.push(
          `Include cycle detected: ${[...stack, relPath].join(" -> ")}`,
        );
        return "";
      }
      const included = includeMap.get(relPath);
      if (included === undefined) {
        warnings.push(`Missing include: ${relPath}`);
        return "";
      }
      return resolveIncludes(
        included,
        includeMap,
        warnings,
        [...stack, relPath],
      );
    },
  );
}

function platformDefine(platform: PlatformMacro): string {
  if (platform === "windows")
    return "#define MC_OS_WINDOWS";
  if (platform === "mac") return "#define MC_OS_MAC";
  return "#define MC_OS_LINUX";
}

const RENDER_STAGE_VALUES: Record<string, number> = {
  MC_RENDER_STAGE_NONE: 0,
  MC_RENDER_STAGE_SKY: 1,
  MC_RENDER_STAGE_SUNSET: 2,
  MC_RENDER_STAGE_STARS: 3,
  MC_RENDER_STAGE_VOID: 4,
  MC_RENDER_STAGE_TERRAIN_SOLID: 5,
  MC_RENDER_STAGE_TERRAIN_CUTOUT: 6,
  MC_RENDER_STAGE_TERRAIN_TRANSLUCENT: 7,
  MC_RENDER_STAGE_WATER: 8,
  MC_RENDER_STAGE_SHADOW: 9,
};

export function preprocessShader(
  input: PreprocessInput,
): PreprocessOutput {
  const warnings: string[] = [];

  const versionMatch = input.source.match(
    /^\s*#version\s+.+$/m,
  );
  const versionLine =
    versionMatch?.[0]?.trim() ?? "#version 330";

  let rest = input.source;
  if (versionMatch) {
    rest = rest.replace(versionMatch[0], "");
  }

  rest = resolveIncludes(rest, input.includeMap, warnings);

  const stageDefine = STAGE_DEFINE[input.stage];
  const stageValue = RENDER_STAGE_VALUES[stageDefine] ?? 0;

  const macroLines: string[] = [
    // Engine identification
    "#define ROUGHLY_A_3D_GAME 1",
    "#define ENGINE_VERSION 1",
    "#define MC_BACKEND_WEBGPU 1",
    // Platform
    platformDefine(input.platform),
    // GLSL/GL version info
    "#define MC_GL_VERSION 460",
    "#define MC_GLSL_VERSION 460",
    // Render stage constants
    "#define MC_RENDER_STAGE_NONE 0",
    "#define MC_RENDER_STAGE_SKY 1",
    "#define MC_RENDER_STAGE_SUNSET 2",
    "#define MC_RENDER_STAGE_STARS 3",
    "#define MC_RENDER_STAGE_VOID 4",
    "#define MC_RENDER_STAGE_TERRAIN_SOLID 5",
    "#define MC_RENDER_STAGE_TERRAIN_CUTOUT 6",
    "#define MC_RENDER_STAGE_TERRAIN_TRANSLUCENT 7",
    "#define MC_RENDER_STAGE_WATER 8",
    "#define MC_RENDER_STAGE_SHADOW 9",
    // Current stage
    `#define MC_RENDER_STAGE ${stageValue}`,
    // Material format
    "#define MC_NORMAL_MAP 1",
    "#define MC_SPECULAR_MAP 1",
    "#define MC_TEXTURE_FORMAT_LAB_PBR 1",
    "#define MC_TEXTURE_FORMAT_LAB_PBR_1_3 1",
    // Render quality
    "#define MC_SHADOW_QUALITY 1.0",
    "#define MC_RENDER_QUALITY 1.0",
    // Geometry shader unavailable in WebGPU
    "#define MC_NO_GEOMETRY_SHADER 1",
  ];

  for (const [k, v] of input.options) {
    macroLines.push(`#define ${k} ${v}`);
  }

  const code = [
    versionLine,
    ...macroLines,
    rest.trimStart(),
  ].join("\n");
  return { code, warnings };
}
