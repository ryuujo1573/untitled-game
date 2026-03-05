import type { VFS } from "~/engine/vfs/types";

let instance: VFS | null = null;

/**
 * Returns the singleton VFS instance.
 * On Tauri it writes to `$APPDATA/voxxer/`; on the web it uses OPFS.
 */
export async function getVFS(): Promise<VFS> {
  if (instance) return instance;

  if (import.meta.isTauri) {
    const { createTauriVFS } = await import(
      "~/engine/vfs/tauri-vfs"
    );
    instance = await createTauriVFS();
  } else {
    const { createWebVFS } = await import("~/engine/vfs/web-vfs");
    instance = await createWebVFS();
  }

  return instance;
}
