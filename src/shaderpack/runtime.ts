import { open } from "@tauri-apps/plugin-dialog";
import { buildManifestFromVirtualFiles } from "~/shaderpack/loader";
import { buildVirtualFilesFromBrowserFiles } from "~/shaderpack/loader-web";
import {
  buildVirtualFilesFromFolder,
  readZipFileBytes,
} from "~/shaderpack/loader-tauri";
import { extractZipToVirtualFiles } from "~/shaderpack/zip";
import {
  addShaderpack,
  readShaderpackFiles,
} from "~/shaderpack/library";
import {
  STAGE_NAMES,
  type ActiveShaderpackInfo,
  type ShaderStageName,
} from "~/shaderpack/types";
import type {
  ShaderpackDiagnostics,
  ShaderpackManifest,
  ShaderpackSource,
} from "~/shaderpack/types";
import type { ShaderStageStatus } from "~/shaderpack/registry";

interface ShaderpackRuntimeState {
  active: ActiveShaderpackInfo | null;
  manifest: ShaderpackManifest | null;
  diagnostics: ShaderpackDiagnostics;
  stageStatuses: ShaderStageStatus[];
}

const listeners = new Set<() => void>();
const state: ShaderpackRuntimeState = {
  active: null,
  manifest: null,
  diagnostics: { errors: [], warnings: [] },
  stageStatuses: STAGE_NAMES.map((stage) => ({
    stage,
    mode: "builtin",
    reason: "No shaderpack loaded",
  })),
};

function emit(): void {
  for (const l of listeners) l();
}

function stripPackName(path: string): string {
  const clean = path
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const last = clean.split("/").pop();
  return last && last.length > 0 ? last : "shaderpack";
}

async function loadVirtualFiles(
  source: ShaderpackSource,
): Promise<{
  files: Map<string, string>;
  binaryFiles: Map<string, Uint8Array>;
  warnings: string[];
}> {
  if (source.kind === "vfs") {
    return {
      files: await readShaderpackFiles(source.name),
      binaryFiles: new Map(),
      warnings: [],
    };
  }

  if (source.kind === "browser-files") {
    return {
      files: await buildVirtualFilesFromBrowserFiles(
        source.files,
      ),
      binaryFiles: new Map(),
      warnings: [],
    };
  }

  if (source.kind === "folder") {
    const result = await buildVirtualFilesFromFolder(
      source.path,
    );
    return {
      files: result.textFiles,
      binaryFiles: result.binaryFiles,
      warnings: [],
    };
  }

  const bytes = await readZipFileBytes(source.path);
  const extracted = await extractZipToVirtualFiles(bytes);
  return {
    files: extracted.files,
    binaryFiles: extracted.binaryFiles,
    warnings: extracted.warnings,
  };
}

function deriveName(source: ShaderpackSource): string {
  if (source.kind === "vfs") return source.name;
  if (source.kind === "browser-files") {
    if (source.name) return source.name;
    // Try to infer from the first file's webkitRelativePath.
    const first = source.files[0];
    const rel =
      (first as File & { webkitRelativePath?: string })
        .webkitRelativePath ?? "";
    const segments = rel.split("/").filter(Boolean);
    // If there's a folder prefix before "shaders/", use it as the pack name.
    if (segments.length > 1 && segments[0] !== "shaders")
      return segments[0];
    return "browser-shaderpack";
  }
  return stripPackName(source.path);
}

function stageStatusBase(
  stage: ShaderStageName,
  reason: string,
): ShaderStageStatus {
  return { stage, mode: "builtin", reason };
}

/**
 * Walk the manifest and report every stage as "builtin".
 * GLSL→WGSL compilation has been removed; shaderpacks are loaded for
 * property-parsing purposes only (clouds mode, block-id maps, etc.).
 */
function computeStageStatuses(
  manifest: ShaderpackManifest,
): ShaderStageStatus[] {
  return STAGE_NAMES.map((stage) => {
    const p = manifest.programs.get(stage);
    if (!p || (!p.fragment && !p.vertex)) {
      return stageStatusBase(stage, "No stage in pack");
    }
    return stageStatusBase(
      stage,
      "GLSL→WGSL compilation unavailable",
    );
  });
}

export function subscribeShaderpackRuntime(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getShaderpackStateSnapshot(): ShaderpackRuntimeState {
  return {
    active: state.active,
    manifest: state.manifest,
    diagnostics: {
      errors: [...state.diagnostics.errors],
      warnings: [...state.diagnostics.warnings],
    },
    stageStatuses: state.stageStatuses.map((s) => ({
      ...s,
    })),
  };
}

export async function loadShaderpack(
  source: ShaderpackSource,
): Promise<void> {
  const sourceWarnings: string[] = [];
  try {
    const { files, binaryFiles, warnings } =
      await loadVirtualFiles(source);
    sourceWarnings.push(...warnings);

    if (
      !files.has("shaders/shaders.properties") &&
      ![...files.keys()].some((p) =>
        p.startsWith("shaders/"),
      )
    ) {
      throw new Error(
        "Shaderpack is missing the shaders/ directory or readable shader files.",
      );
    }

    const name = deriveName(source);
    const manifest = buildManifestFromVirtualFiles(
      files,
      name,
      binaryFiles,
    );
    const stageStatuses = computeStageStatuses(manifest);

    const warningsCombined = [
      ...sourceWarnings,
      ...manifest.properties.warnings,
      ...manifest.blockMap.warnings,
      ...stageStatuses
        .filter((s) => s.mode === "builtin" && s.reason)
        .map((s) => `[${s.stage}] ${s.reason}`),
    ];

    state.active = { name, source, loadedAtMs: Date.now() };
    state.manifest = manifest;
    state.stageStatuses = stageStatuses;
    state.diagnostics = {
      errors: [],
      warnings: warningsCombined.map((message) => ({
        message,
      })),
    };

    // Persist to VFS so the pack appears in the library on next scan.
    if (source.kind !== "vfs") {
      await addShaderpack(name, files).catch(() => {});
    }
  } catch (error) {
    state.active = null;
    state.manifest = null;
    state.stageStatuses = STAGE_NAMES.map((stage) => ({
      stage,
      mode: "builtin",
      reason: "No shaderpack loaded",
    }));
    state.diagnostics = {
      errors: [
        {
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
      ],
      warnings: sourceWarnings.map((message) => ({
        message,
      })),
    };
  }

  emit();
}

export function unloadShaderpack(): void {
  state.active = null;
  state.manifest = null;
  state.stageStatuses = STAGE_NAMES.map((stage) => ({
    stage,
    mode: "builtin",
    reason: "No shaderpack loaded",
  }));
  state.diagnostics = { errors: [], warnings: [] };
  emit();
}

export function getActiveShaderpackInfo(): ActiveShaderpackInfo | null {
  return state.active;
}

export function getShaderpackDiagnostics(): ShaderpackDiagnostics {
  return {
    errors: [...state.diagnostics.errors],
    warnings: [...state.diagnostics.warnings],
  };
}

export async function pickAndLoadShaderpackFolder(): Promise<void> {
  if (!import.meta.isTauri) {
    throw new Error(
      "Folder picker is only available in Tauri mode.",
    );
  }

  const selected = await open({
    directory: true,
    multiple: false,
  });
  if (!selected || Array.isArray(selected)) return;
  await loadShaderpack({ kind: "folder", path: selected });
}

export async function pickAndLoadShaderpackZip(): Promise<void> {
  if (!import.meta.isTauri) {
    throw new Error(
      "ZIP picker is only available in Tauri mode.",
    );
  }

  const selected = await open({
    directory: false,
    multiple: false,
    filters: [
      { name: "Shaderpack ZIP", extensions: ["zip"] },
    ],
  });
  if (!selected || Array.isArray(selected)) return;
  await loadShaderpack({ kind: "zip", path: selected });
}
