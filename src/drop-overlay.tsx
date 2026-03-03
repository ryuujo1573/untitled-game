import { createSignal, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { Plus } from "lucide-solid";
import { loadShaderpack } from "~/shaderpack/runtime";
import {
  navigateToShaderpacks,
  setHighlightedPack,
} from "~/pause-menu";
import { extractZipToVirtualFiles } from "~/shaderpack/zip";

// ── Helpers for reading dropped files in the browser ──────────

/** Recursively read a FileSystemDirectoryEntry into a flat file map. */
function readDirectoryEntry(
  dirEntry: FileSystemDirectoryEntry,
  prefix: string,
): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, string>();
    const reader = dirEntry.createReader();
    const pending: Promise<void>[] = [];

    function readBatch() {
      reader.readEntries(async (entries) => {
        if (entries.length === 0) {
          await Promise.all(pending);
          resolve(out);
          return;
        }
        for (const entry of entries) {
          const rel = prefix
            ? `${prefix}/${entry.name}`
            : entry.name;
          if (entry.isDirectory) {
            pending.push(
              readDirectoryEntry(
                entry as FileSystemDirectoryEntry,
                rel,
              ).then((sub) => {
                for (const [k, v] of sub) out.set(k, v);
              }),
            );
          } else {
            pending.push(
              new Promise<void>((res, rej) => {
                (entry as FileSystemFileEntry).file(
                  (file) => {
                    file
                      .text()
                      .then((text) => {
                        out.set(rel, text);
                        res();
                      })
                      .catch(rej);
                  },
                  rej,
                );
              }),
            );
          }
        }
        readBatch();
      }, reject);
    }

    readBatch();
  });
}

/** Extract a pack name from a dropped directory or zip file name. */
function nameFromEntry(name: string): string {
  return (
    name.replace(/\.zip$/i, "").replace(/[/\\]+$/, "") ||
    "shaderpack"
  );
}

// ── Component ─────────────────────────────────────────────────

function DropOverlayUI() {
  const [dragging, setDragging] = createSignal(false);
  const [processing, setProcessing] = createSignal(false);
  let dragCounter = 0;

  // ── Browser HTML5 drag events ─────────────────────────────
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) setDragging(true);
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      setDragging(false);
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    setDragging(false);

    if (!e.dataTransfer) return;
    setProcessing(true);

    try {
      let files: Map<string, string> | null = null;
      let packName = "shaderpack";

      // Try directory drop via webkitGetAsEntry.
      const items = e.dataTransfer.items;
      if (items && items.length > 0) {
        const entry = items[0].webkitGetAsEntry?.();
        if (entry?.isDirectory) {
          packName = nameFromEntry(entry.name);
          files = await readDirectoryEntry(
            entry as FileSystemDirectoryEntry,
            "",
          );
        }
      }

      // Fallback: check for zip file drop.
      if (!files && e.dataTransfer.files.length > 0) {
        const droppedFile = e.dataTransfer.files[0];
        if (
          droppedFile.name.toLowerCase().endsWith(".zip")
        ) {
          packName = nameFromEntry(droppedFile.name);
          const bytes = new Uint8Array(
            await droppedFile.arrayBuffer(),
          );
          const result =
            await extractZipToVirtualFiles(bytes);
          files = result.files;
        } else {
          // Treat as flat file list (non-zip).
          const fileList = Array.from(e.dataTransfer.files);
          packName = nameFromEntry(fileList[0].name);
          files = new Map<string, string>();
          for (const f of fileList) {
            const rel =
              (f as any).webkitRelativePath || f.name;
            files.set(rel, await f.text());
          }
        }
      }

      if (files && files.size > 0) {
        await loadShaderpack({
          kind: "browser-files",
          files: fileListFromMap(files),
          name: packName,
        });
        // VFS persist happens automatically in runtime.
        // Navigate to shaderpacks panel and highlight the new entry.
        navigateToShaderpacks();
        setHighlightedPack(packName);
      }
    } catch {
      // Silently ignore drop errors.
    } finally {
      setProcessing(false);
    }
  };

  // ── Tauri native drag-drop ────────────────────────────────
  let unlistenTauri: (() => void) | undefined;

  if (import.meta.isTauri) {
    // Dynamic import to avoid bundling Tauri code in web builds.
    import("@tauri-apps/api/webviewWindow").then(
      ({ getCurrentWebviewWindow }) => {
        getCurrentWebviewWindow()
          .onDragDropEvent(async (event) => {
            const { type } = event.payload;
            if (type === "enter" || type === "over") {
              setDragging(true);
            } else if (type === "leave") {
              setDragging(false);
            } else if (type === "drop") {
              setDragging(false);
              const paths: string[] =
                (event.payload as any).paths ?? [];
              if (paths.length === 0) return;

              setProcessing(true);
              try {
                const path = paths[0];
                const packName = nameFromEntry(
                  path.split("/").pop() ?? "shaderpack",
                );

                if (path.toLowerCase().endsWith(".zip")) {
                  // Zip file: read bytes and extract.
                  await loadShaderpack({
                    kind: "zip",
                    path,
                  });
                } else {
                  // Directory: read folder files.
                  const { buildVirtualFilesFromFolder } =
                    await import(
                      "~/shaderpack/loader-tauri"
                    );
                  const result =
                    await buildVirtualFilesFromFolder(path);
                  if (result.textFiles.size > 0) {
                    await loadShaderpack({
                      kind: "browser-files",
                      files: fileListFromMap(
                        result.textFiles,
                      ),
                      name: packName,
                    });
                  }
                }
                navigateToShaderpacks();
                setHighlightedPack(packName);
              } catch {
                // Ignore errors.
              } finally {
                setProcessing(false);
              }
            }
          })
          .then((unlisten) => {
            unlistenTauri = unlisten;
          });
      },
    );
  }

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  onCleanup(() => {
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
    unlistenTauri?.();
  });

  return (
    <Show when={dragging() || processing()}>
      <div
        class="fixed inset-0 z-60 flex items-center justify-center bg-black/70 backdrop-blur-sm transition-opacity duration-200"
        classList={{
          "opacity-100": dragging(),
          "opacity-80": !dragging() && processing(),
        }}
      >
        <div class="flex flex-col items-center gap-4 p-12 border-2 border-dashed border-white/30 rounded-2xl">
          <div class="flex items-center justify-center w-14 h-14 rounded-full bg-primary/20">
            <Plus
              size={28}
              class="text-primary"
              stroke-width={2.5}
            />
          </div>
          <div class="text-center">
            <p class="text-white text-xl font-semibold tracking-wide">
              {processing()
                ? "Adding Shaderpack…"
                : "Add Shaderpack"}
            </p>
            <p class="text-white/50 text-sm mt-1">
              {processing()
                ? "Please wait"
                : "drop to confirm"}
            </p>
          </div>
        </div>
      </div>
    </Show>
  );
}

/** Convert a Map<path, text> into an array of File objects for the browser-files source. */
function fileListFromMap(
  files: Map<string, string>,
): File[] {
  const out: File[] = [];
  for (const [path, content] of files) {
    const f = new File(
      [content],
      path.split("/").pop() ?? "file",
      {
        type: "text/plain",
      },
    );
    // Patch webkitRelativePath for the loader.
    Object.defineProperty(f, "webkitRelativePath", {
      value: path,
    });
    out.push(f);
  }
  return out;
}

/** Mount the drop overlay into the given container. */
export function mountDropOverlay(
  container: HTMLElement,
): () => void {
  return render(() => <DropOverlayUI />, container);
}
