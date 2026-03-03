import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { Settings } from "~/settings";
import { loadShaderpack } from "~/shaderpack/runtime";

type DirEntry = { name?: string; isDirectory?: boolean; isFile?: boolean };

export function getLibraryPath(): string | null {
  return Settings.shaderpackLibraryPath;
}

/**
 * Opens a directory picker and saves the chosen path as the library directory.
 * Returns the chosen path, or null if the user cancelled.
 */
export async function pickLibraryDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return null;
  Settings.shaderpackLibraryPath = selected;
  Settings.save();
  return selected;
}

/**
 * Scans the configured library directory and returns names of subdirectories
 * that look like shaderpacks (i.e. contain a `shaders/` subdirectory).
 */
export async function scanLibrary(): Promise<string[]> {
  const libraryPath = Settings.shaderpackLibraryPath;
  if (!libraryPath) return [];

  const topEntries = (await readDir(libraryPath)) as DirEntry[];
  const packs: string[] = [];

  for (const entry of topEntries) {
    if (!entry.name || !entry.isDirectory) continue;

    const packPath = `${libraryPath}/${entry.name}`;
    const packEntries = (await readDir(packPath).catch(() => [])) as DirEntry[];
    const hasShaders = packEntries.some((e) => e.name === "shaders" && e.isDirectory);
    if (hasShaders) packs.push(entry.name);
  }

  packs.sort((a, b) => a.localeCompare(b));
  return packs;
}

/**
 * Loads a named shaderpack from the library directory.
 */
export async function loadPackFromLibrary(packName: string): Promise<void> {
  const libraryPath = Settings.shaderpackLibraryPath;
  if (!libraryPath) throw new Error("No library directory configured.");
  await loadShaderpack({ kind: "folder", path: `${libraryPath}/${packName}` });
}
