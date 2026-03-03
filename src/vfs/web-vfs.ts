import FS from "@isomorphic-git/lightning-fs";
import type { VFS, VFSEntry } from "~/vfs/types";

const lfs = new FS("voxxer");
const pfs = lfs.promises;

/** Ensure all ancestor directories of `absPath` exist. */
async function ensureParent(absPath: string): Promise<void> {
  const parts = absPath.split("/").filter(Boolean);
  parts.pop(); // drop the file name
  let cur = "";
  for (const p of parts) {
    cur += `/${p}`;
    try {
      await pfs.mkdir(cur);
    } catch {
      /* already exists */
    }
  }
}

/** Recursively mkdir. */
async function mkdirp(absPath: string): Promise<void> {
  const parts = absPath.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += `/${p}`;
    try {
      await pfs.mkdir(cur);
    } catch {
      /* already exists */
    }
  }
}

/** Recursively remove a file or directory. */
async function rmrf(absPath: string): Promise<void> {
  const stat = await pfs.stat(absPath);
  if (stat.isDirectory()) {
    const children = await pfs.readdir(absPath);
    for (const child of children) {
      await rmrf(`${absPath}/${child}`);
    }
    await pfs.rmdir(absPath);
  } else {
    await pfs.unlink(absPath);
  }
}

/** Convert a virtual path (no leading slash) to an absolute lightning-fs path. */
function abs(virtual: string): string {
  const clean = virtual.replace(/^\/+/, "");
  return `/${clean}`;
}

export async function createWebVFS(): Promise<VFS> {
  const vfs: VFS = {
    async readDir(path) {
      const dir = abs(path);
      const names = await pfs.readdir(dir);
      const entries: VFSEntry[] = [];
      for (const name of names) {
        const st = await pfs.stat(`${dir}/${name}`);
        entries.push({ name, isDir: st.isDirectory() });
      }
      return entries;
    },

    async readTextFile(path) {
      return (await pfs.readFile(abs(path), "utf8")) as string;
    },

    async readFile(path) {
      return (await pfs.readFile(abs(path))) as Uint8Array;
    },

    async writeTextFile(path, content) {
      const p = abs(path);
      await ensureParent(p);
      await pfs.writeFile(p, content, "utf8");
    },

    async writeFile(path, data) {
      const p = abs(path);
      await ensureParent(p);
      await pfs.writeFile(p, data);
    },

    async mkdir(path) {
      await mkdirp(abs(path));
    },

    async exists(path) {
      try {
        await pfs.stat(abs(path));
        return true;
      } catch {
        return false;
      }
    },

    async remove(path, opts) {
      const p = abs(path);
      if (opts?.recursive) {
        await rmrf(p);
      } else {
        const st = await pfs.stat(p);
        if (st.isDirectory()) {
          await pfs.rmdir(p);
        } else {
          await pfs.unlink(p);
        }
      }
    },
  };

  return vfs;
}
