import {
  readDir as tauriReadDir,
  readTextFile as tauriReadTextFile,
  readFile as tauriReadFile,
  writeTextFile as tauriWriteTextFile,
  writeFile as tauriWriteFile,
  mkdir as tauriMkdir,
  exists as tauriExists,
  remove as tauriRemove,
} from "@tauri-apps/plugin-fs";
import { resourceDir } from "@tauri-apps/api/path";
import type { VFS, VFSEntry } from "~/vfs/types";

function join(root: string, virtual: string): string {
  const clean = virtual.replace(/^\/+/, "");
  return `${root}/${clean}`;
}

export async function createTauriVFS(): Promise<VFS> {
  const base = await resourceDir();
  const root = base.replace(/\/+$/, "");

  // Ensure the root exists.
  await tauriMkdir(root, { recursive: true }).catch(() => {});

  const vfs: VFS = {
    async readDir(path) {
      const abs = join(root, path);
      const raw = (await tauriReadDir(abs)) as Array<{
        name?: string;
        isDirectory?: boolean;
        isFile?: boolean;
      }>;
      const entries: VFSEntry[] = [];
      for (const e of raw) {
        if (!e.name) continue;
        entries.push({ name: e.name, isDir: !!e.isDirectory });
      }
      return entries;
    },

    async readTextFile(path) {
      return tauriReadTextFile(join(root, path));
    },

    async readFile(path) {
      const data = await tauriReadFile(join(root, path));
      return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    },

    async writeTextFile(path, content) {
      const abs = join(root, path);
      const parentSegments = abs.split("/");
      parentSegments.pop();
      const parent = parentSegments.join("/");
      await tauriMkdir(parent, { recursive: true }).catch(() => {});
      await tauriWriteTextFile(abs, content);
    },

    async writeFile(path, data) {
      const abs = join(root, path);
      const parentSegments = abs.split("/");
      parentSegments.pop();
      const parent = parentSegments.join("/");
      await tauriMkdir(parent, { recursive: true }).catch(() => {});
      await tauriWriteFile(abs, data);
    },

    async mkdir(path) {
      await tauriMkdir(join(root, path), { recursive: true }).catch(() => {});
    },

    async exists(path) {
      return tauriExists(join(root, path));
    },

    async remove(path, opts) {
      await tauriRemove(join(root, path), { recursive: opts?.recursive });
    },
  };

  return vfs;
}
