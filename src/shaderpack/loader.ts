import { parseBlockProperties } from "~/shaderpack/parse-block-properties";
import { parseDrawTargetsFromShaderSource } from "~/shaderpack/parse-drawbuffers";
import { parseShadersProperties } from "~/shaderpack/parse-properties";
import type {
  ShaderpackManifest,
  ShaderpackProgram,
  ShaderStageName,
} from "~/shaderpack/types";

const STAGES: ShaderStageName[] = [
  "shadow",
  "shadow_solid",
  "shadow_cutout",
  "gbuffers_clouds",
  "gbuffers_terrain",
  "deferred",
  "deferred1",
  "deferred2",
  "deferred3",
  "composite",
  "composite1",
  "composite2",
  "composite3",
  "final",
];

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function buildManifestFromVirtualFiles(
  files: Map<string, string>,
  packName: string,
): ShaderpackManifest {
  const normalized = new Map<string, string>();
  for (const [k, v] of files) {
    normalized.set(normalize(k), v);
  }

  const programs = new Map<ShaderStageName, ShaderpackProgram>();
  const includes = new Map<string, string>();

  for (const stage of STAGES) {
    const vsh = normalized.get(`shaders/${stage}.vsh`);
    const fsh = normalized.get(`shaders/${stage}.fsh`);
    if (!vsh && !fsh) continue;

    const prog: ShaderpackProgram = { stage };
    if (vsh) prog.vertex = vsh;
    if (fsh) {
      prog.fragment = fsh;
      const targets = parseDrawTargetsFromShaderSource(fsh);
      if (targets) {
        const isDrawBuffers = /DRAWBUFFERS/i.test(fsh);
        if (isDrawBuffers) prog.drawBuffers = targets;
        else prog.renderTargets = targets;
      }
    }
    programs.set(stage, prog);
  }

  for (const [path, content] of normalized) {
    if (!path.startsWith("shaders/")) continue;
    if (path.endsWith(".vsh") || path.endsWith(".fsh")) continue;
    if (path.endsWith(".properties")) continue;
    includes.set(path.slice("shaders/".length), content);
  }

  const properties = parseShadersProperties(normalized.get("shaders/shaders.properties") ?? "");
  const blockMap = parseBlockProperties(normalized.get("shaders/block.properties") ?? "");

  return {
    packName,
    programs,
    properties,
    blockMap,
    includes,
  };
}
