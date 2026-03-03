import { open } from "@tauri-apps/plugin-dialog";
import { buildManifestFromVirtualFiles } from "~/shaderpack/loader";
import { buildVirtualFilesFromBrowserFiles } from "~/shaderpack/loader-web";
import { buildVirtualFilesFromFolder, readZipFileBytes } from "~/shaderpack/loader-tauri";
import { transpileGLSLToWGSL } from "~/shaderpack/naga";
import { preprocessShader } from "~/shaderpack/preprocess";
import { extractZipToVirtualFiles } from "~/shaderpack/zip";
import { addShaderpack, readShaderpackFiles } from "~/shaderpack/library";
import { STAGE_NAMES, type ActiveShaderpackInfo, type ShaderStageName } from "~/shaderpack/types";
import type { ShaderpackDiagnostics, ShaderpackManifest, ShaderpackSource } from "~/shaderpack/types";
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

function detectPlatform(): "windows" | "mac" | "linux" {
  const p = navigator.platform.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac")) return "mac";
  return "linux";
}

function stripPackName(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const last = clean.split("/").pop();
  return last && last.length > 0 ? last : "shaderpack";
}

async function loadVirtualFiles(source: ShaderpackSource): Promise<{ files: Map<string, string>; warnings: string[] }> {
  if (source.kind === "vfs") {
    return { files: await readShaderpackFiles(source.name), warnings: [] };
  }

  if (source.kind === "browser-files") {
    return { files: await buildVirtualFilesFromBrowserFiles(source.files), warnings: [] };
  }

  if (source.kind === "folder") {
    return { files: await buildVirtualFilesFromFolder(source.path), warnings: [] };
  }

  const bytes = await readZipFileBytes(source.path);
  const extracted = await extractZipToVirtualFiles(bytes);
  return { files: extracted.files, warnings: extracted.warnings };
}

function deriveName(source: ShaderpackSource): string {
  if (source.kind === "vfs") return source.name;
  if (source.kind === "browser-files") {
    if (source.name) return source.name;
    // Try to infer from the first file's webkitRelativePath.
    const first = source.files[0];
    const rel = (first as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const segments = rel.split("/").filter(Boolean);
    // If there's a folder prefix before "shaders/", use it as the pack name.
    if (segments.length > 1 && segments[0] !== "shaders") return segments[0];
    return "browser-shaderpack";
  }
  return stripPackName(source.path);
}

function stageStatusBase(stage: ShaderStageName, reason: string): ShaderStageStatus {
  return { stage, mode: "builtin", reason };
}

async function computeStageStatuses(manifest: ShaderpackManifest): Promise<ShaderStageStatus[]> {
  const statuses: ShaderStageStatus[] = [];
  const platform = detectPlatform();

  for (const stage of STAGE_NAMES) {
    const p = manifest.programs.get(stage);
    if (!p) {
      statuses.push(stageStatusBase(stage, "Missing stage program in pack"));
      continue;
    }

    const shaderSource = p.fragment ?? p.vertex;
    if (!shaderSource) {
      statuses.push(stageStatusBase(stage, "Stage has no shader source"));
      continue;
    }

    const pre = preprocessShader({
      source: shaderSource,
      stage,
      includeMap: manifest.includes,
      options: manifest.properties.options,
      platform,
    });

    const transpile = await transpileGLSLToWGSL(pre.code, p.fragment ? "fragment" : "vertex");
    if (!transpile.ok) {
      statuses.push(stageStatusBase(stage, transpile.error ?? "GLSL->WGSL transpile failed"));
      continue;
    }

    statuses.push({ stage, mode: "override" });
  }

  return statuses;
}

export function subscribeShaderpackRuntime(listener: () => void): () => void {
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
    stageStatuses: state.stageStatuses.map((s) => ({ ...s })),
  };
}

export async function loadShaderpack(source: ShaderpackSource): Promise<void> {
  const sourceWarnings: string[] = [];
  try {
    const { files, warnings } = await loadVirtualFiles(source);
    sourceWarnings.push(...warnings);

    if (!files.has("shaders/shaders.properties") && ![...files.keys()].some((p) => p.startsWith("shaders/"))) {
      throw new Error("Shaderpack is missing the shaders/ directory or readable shader files.");
    }

    const name = deriveName(source);
    const manifest = buildManifestFromVirtualFiles(files, name);
    const stageStatuses = await computeStageStatuses(manifest);

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
      warnings: warningsCombined.map((message) => ({ message })),
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
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
      warnings: sourceWarnings.map((message) => ({ message })),
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
    throw new Error("Folder picker is only available in Tauri mode.");
  }

  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return;
  await loadShaderpack({ kind: "folder", path: selected });
}

export async function pickAndLoadShaderpackZip(): Promise<void> {
  if (!import.meta.isTauri) {
    throw new Error("ZIP picker is only available in Tauri mode.");
  }

  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "Shaderpack ZIP", extensions: ["zip"] }],
  });
  if (!selected || Array.isArray(selected)) return;
  await loadShaderpack({ kind: "zip", path: selected });
}
