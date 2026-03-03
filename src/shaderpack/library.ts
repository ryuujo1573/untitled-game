import { getVFS } from "~/vfs";
import type { VFS } from "~/vfs/types";
import { loadShaderpack } from "~/shaderpack/runtime";

const SHADERPACKS_DIR = "shaderpacks";

/** Ensure the top-level shaderpacks directory exists. */
async function ensureRoot(vfs: VFS): Promise<void> {
  await vfs.mkdir(SHADERPACKS_DIR);
}

/**
 * Store a shaderpack's files into the VFS under `shaderpacks/<name>/`.
 * Overwrites any existing pack with the same name.
 */
export async function addShaderpack(name: string, files: Map<string, string>): Promise<void> {
  const vfs = await getVFS();
  await ensureRoot(vfs);

  const packRoot = `${SHADERPACKS_DIR}/${name}`;

  // Remove old data if present.
  if (await vfs.exists(packRoot)) {
    await vfs.remove(packRoot, { recursive: true });
  }

  for (const [relPath, content] of files) {
    await vfs.writeTextFile(`${packRoot}/${relPath}`, content);
  }
}

/**
 * Scans the VFS shaderpacks directory and returns sorted pack names.
 */
export async function scanLibrary(): Promise<string[]> {
  const vfs = await getVFS();
  await ensureRoot(vfs);

  const entries = await vfs.readDir(SHADERPACKS_DIR);
  return entries
    .filter((e) => e.isDir)
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Remove a shaderpack from the VFS library.
 */
export async function removeShaderpack(name: string): Promise<void> {
  const vfs = await getVFS();
  await vfs.remove(`${SHADERPACKS_DIR}/${name}`, { recursive: true });
}

/**
 * Read all files from a stored shaderpack into a virtual file map.
 */
export async function readShaderpackFiles(name: string): Promise<Map<string, string>> {
  const vfs = await getVFS();
  const packRoot = `${SHADERPACKS_DIR}/${name}`;
  const out = new Map<string, string>();

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await vfs.readDir(dir);
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDir) {
        await walk(`${dir}/${entry.name}`, rel);
      } else {
        const text = await vfs.readTextFile(`${dir}/${entry.name}`);
        out.set(rel, text);
      }
    }
  }

  await walk(packRoot, "");
  return out;
}

/**
 * Load a named shaderpack from the VFS library and activate it.
 */
export async function loadPackFromLibrary(name: string): Promise<void> {
  await loadShaderpack({ kind: "vfs", name });
}
