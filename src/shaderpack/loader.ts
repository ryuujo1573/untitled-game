import { parseBlockProperties } from "~/shaderpack/parse-block-properties";
import { parseDrawTargetsFromShaderSource } from "~/shaderpack/parse-drawbuffers";
import { parseShadersProperties } from "~/shaderpack/parse-properties";
import { STAGE_NAMES } from "~/shaderpack/types";
import type {
  ShaderpackManifest,
  ShaderpackProgram,
  ShaderStageName,
} from "~/shaderpack/types";

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function buildManifestFromVirtualFiles(
  files: Map<string, string>,
  packName: string,
  binaryFiles?: Map<string, Uint8Array>,
): ShaderpackManifest {
  const normalized = new Map<string, string>();
  for (const [k, v] of files) {
    normalized.set(normalize(k), v);
  }

  const programs = new Map<
    ShaderStageName,
    ShaderpackProgram
  >();
  const includes = new Map<string, string>();

  for (const stage of STAGE_NAMES) {
    const vsh = normalized.get(`shaders/${stage}.vsh`);
    const fsh = normalized.get(`shaders/${stage}.fsh`);
    const gsh = normalized.get(`shaders/${stage}.gsh`);
    const csh = normalized.get(`shaders/${stage}.csh`);
    if (!vsh && !fsh && !csh) continue;

    const prog: ShaderpackProgram = { stage };
    if (vsh) prog.vertex = vsh;
    if (gsh) prog.geometry = gsh;
    if (csh) prog.compute = csh;
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
    if (
      path.endsWith(".vsh") ||
      path.endsWith(".fsh") ||
      path.endsWith(".gsh") ||
      path.endsWith(".csh")
    )
      continue;
    if (path.endsWith(".properties")) continue;
    includes.set(path.slice("shaders/".length), content);
  }

  const properties = parseShadersProperties(
    normalized.get("shaders/shaders.properties") ?? "",
  );
  const blockMap = parseBlockProperties(
    normalized.get("shaders/block.properties") ?? "",
  );

  return {
    packName,
    programs,
    properties,
    blockMap,
    includes,
    binaryFiles: binaryFiles ?? new Map(),
  };
}
