import {
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-solid";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { render } from "solid-js/web";
import { Settings } from "~/logic/settings/settings";
import {
  loadPackFromLibrary,
  scanLibrary,
} from "~/engine/shaderpack/library";
import {
  getShaderpackStateSnapshot,
  loadShaderpack,
  pickAndLoadShaderpackFolder,
  pickAndLoadShaderpackZip,
  subscribeShaderpackRuntime,
  unloadShaderpack,
} from "~/engine/shaderpack/runtime";
import { extractZipToVirtualFiles } from "~/engine/shaderpack/zip";

// ── Constants ──────────────────────────────────────────────────
const SNAP_POINTS = [
  0, 25, 50, 75, 100, 125, 150, 175, 200,
];
const SNAP_THRESHOLD = 8;

// ── Shared reactive state (readable from outside Solid) ───────
const [paused, setPaused] = createSignal(false);
const [panel, setPanel] = createSignal<
  "pause" | "settings" | "shaderpacks"
>("pause");
const [quitConfirmOpen, setQuitConfirmOpen] =
  createSignal(false);

const [sceneLuma, setSceneLuma] = createSignal(0);

/** Pack name to visually highlight (set by drag-drop). Auto-clears. */
const [highlightedPack, setHighlightedPackRaw] =
  createSignal<string | null>(null);
let highlightTimer:
  | ReturnType<typeof setTimeout>
  | undefined;

export function setHighlightedPack(name: string): void {
  clearTimeout(highlightTimer);
  setHighlightedPackRaw(name);
  highlightTimer = setTimeout(
    () => setHighlightedPackRaw(null),
    3000,
  );
}

export function updateSceneLuma(luma: number): void {
  setSceneLuma(luma);
}

/** Navigate directly into the shaderpacks panel (used by drag-drop overlay). */
export function navigateToShaderpacks(): void {
  setPaused(true);
  setPanel("shaderpacks");
}

export type QuitToTitleIntent =
  | "save"
  | "discard"
  | "cancel";

export class PauseMenu {
  private readonly onResume: () => void;
  private readonly onQuitRequested: (
    intent: QuitToTitleIntent,
  ) => void;
  private disposeUI: (() => void) | null = null;

  constructor(
    onResume: () => void,
    onQuitRequested: (intent: QuitToTitleIntent) => void,
  ) {
    this.onResume = onResume;
    this.onQuitRequested = onQuitRequested;
  }

  get paused(): boolean {
    return paused();
  }

  toggle(): void {
    if (paused()) this.resume();
    else this.pause();
  }

  pause(): void {
    setPaused(true);
    setPanel("pause");
    setQuitConfirmOpen(false);
  }

  resume(): void {
    setPaused(false);
    this.onResume();
  }

  mount(container: HTMLElement): void {
    this.disposeUI = render(
      () => <PauseOverlay menu={this} />,
      container,
    );
  }

  openQuitConfirm(): void {
    setQuitConfirmOpen(true);
  }

  submitQuitIntent(intent: QuitToTitleIntent): void {
    if (intent === "cancel") {
      setQuitConfirmOpen(false);
      this.onQuitRequested(intent);
      return;
    }
    setQuitConfirmOpen(false);
    setPaused(false);
    this.onQuitRequested(intent);
  }

  destroy(): void {
    this.disposeUI?.();
    this.disposeUI = null;
  }
}

// ── Solid component ───────────────────────────────────────────
function PauseOverlay(props: { menu: PauseMenu }) {
  // ── Brightness state ────────────────────────────────────────
  const initPct = Math.round(Settings.brightness * 100);
  const [brightness, setBrightness] = createSignal(initPct);
  const [showSnapHint, setShowSnapHint] =
    createSignal(false);
  const [altPressed, setAltPressed] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);

  // ── HDR state ───────────────────────────────────────────────
  const [hdr, setHdr] = createSignal(Settings.hdr);

  // ── Shaderpack state ────────────────────────────────────────
  const [shaderpackStatus, setShaderpackStatus] =
    createSignal("No shaderpack loaded");
  const [activePackName, setActivePackName] = createSignal<
    string | null
  >(null);
  const [shaderpackError, setShaderpackError] =
    createSignal<string | null>(null);

  // ── Library state (VFS-backed) ──────────────────────────────
  const [libraryPacks, setLibraryPacks] = createSignal<
    string[]
  >([]);
  const [libraryScanning, setLibraryScanning] =
    createSignal(false);
  const [libraryError, setLibraryError] = createSignal<
    string | null
  >(null);

  let zipInputRef: HTMLInputElement | undefined;
  let folderInputRef: HTMLInputElement | undefined;

  const refreshShaderpackStatus = () => {
    const snapshot = getShaderpackStateSnapshot();
    const active = snapshot.active;
    if (!active) {
      setShaderpackStatus("No shaderpack loaded");
      setActivePackName(null);
      return;
    }
    const overrides = snapshot.stageStatuses.filter(
      (s) => s.mode === "override",
    ).length;
    const total = snapshot.stageStatuses.length;
    setShaderpackStatus(
      `${active.name} (${overrides}/${total})`,
    );
    setActivePackName(active.name);
  };

  const isBright = () => sceneLuma() > 160;

  // ── Alt-key tracking ────────────────────────────────────────
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Alt") return;
    if (panel() !== "pause") e.preventDefault();
    setAltPressed(true);
    setShowSnapHint(false);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Alt") setAltPressed(false);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  const unsubShaderpack = subscribeShaderpackRuntime(() => {
    refreshShaderpackStatus();
  });
  refreshShaderpackStatus();
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    unsubShaderpack();
  });

  // ── Library scan ────────────────────────────────────────────
  const doScanLibrary = async () => {
    setLibraryScanning(true);
    setLibraryError(null);
    try {
      setLibraryPacks(await scanLibrary());
    } catch (e) {
      setLibraryError(
        e instanceof Error ? e.message : String(e),
      );
      setLibraryPacks([]);
    } finally {
      setLibraryScanning(false);
    }
  };

  // Scan when shaderpacks panel opens.
  createEffect(() => {
    if (panel() === "shaderpacks") {
      doScanLibrary().catch(() => {});
    }
  });

  // ── Slider input handler ────────────────────────────────────
  const onSliderInput = (e: InputEvent) => {
    const raw = Number(
      (e.currentTarget as HTMLInputElement).value,
    );
    let v = raw;

    if (!altPressed()) {
      const nearest = SNAP_POINTS.reduce((a, b) =>
        Math.abs(b - raw) < Math.abs(a - raw) ? b : a,
      );
      if (Math.abs(nearest - raw) <= SNAP_THRESHOLD) {
        v = nearest;
        (e.currentTarget as HTMLInputElement).value =
          String(v);
        setShowSnapHint(true);
      } else {
        setShowSnapHint(false);
      }
    } else {
      setShowSnapHint(false);
    }

    setBrightness(v);
    Settings.brightness = v / 100;
    Settings.save();
  };

  createEffect(() => {
    Settings.hdr = hdr();
    Settings.save();
  });

  // ── Shaderpack handlers ─────────────────────────────────────
  const onLoadFromLibrary = async (name: string) => {
    setShaderpackError(null);
    try {
      await loadPackFromLibrary(name);
    } catch (e) {
      setShaderpackError(
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  const onAddFolder = async () => {
    setShaderpackError(null);
    try {
      if (import.meta.isTauri) {
        await pickAndLoadShaderpackFolder();
      } else {
        folderInputRef?.click();
        return; // web flow continues in onWebFolderPicked
      }
      await doScanLibrary().catch(() => {});
    } catch (e) {
      setShaderpackError(
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  const onAddZip = async () => {
    setShaderpackError(null);
    try {
      if (import.meta.isTauri) {
        await pickAndLoadShaderpackZip();
      } else {
        zipInputRef?.click();
        return; // web flow continues in onWebZipPicked
      }
      await doScanLibrary().catch(() => {});
    } catch (e) {
      setShaderpackError(
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  const onDisableShaderpack = () => {
    setShaderpackError(null);
    unloadShaderpack();
  };

  const onWebFolderPicked = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    await loadShaderpack({
      kind: "browser-files",
      files: Array.from(files),
    });
    input.value = "";
    // Refresh library after adding via file picker (now persisted in VFS).
    await doScanLibrary().catch(() => {});
  };

  const onWebZipPicked = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const fileList = input.files;
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    if (file.name.toLowerCase().endsWith(".zip")) {
      const bytes = new Uint8Array(
        await file.arrayBuffer(),
      );
      const { files } =
        await extractZipToVirtualFiles(bytes);
      if (files.size > 0) {
        // Convert extracted map into File[] with webkitRelativePath set.
        const synthFiles: File[] = [];
        for (const [path, content] of files) {
          const f = new File(
            [content],
            path.split("/").pop() ?? "file",
            {
              type: "text/plain",
            },
          );
          Object.defineProperty(f, "webkitRelativePath", {
            value: path,
          });
          synthFiles.push(f);
        }
        const packName =
          file.name.replace(/\.zip$/i, "") || "shaderpack";
        await loadShaderpack({
          kind: "browser-files",
          files: synthFiles,
          name: packName,
        });
      }
    } else {
      await loadShaderpack({
        kind: "browser-files",
        files: Array.from(fileList),
      });
    }
    input.value = "";
    await doScanLibrary().catch(() => {});
  };

  const onWebPickerError = (e: unknown) => {
    setShaderpackError(
      e instanceof Error ? e.message : String(e),
    );
  };

  // ──────────────────────────────────────────────────────────
  // Whether we're in the settings↔shaderpacks sliding area.
  const inSettingsArea = () =>
    panel() === "settings" || panel() === "shaderpacks";

  // ── Template ──────────────────────────────────────────────
  return (
    <Show when={paused()}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm select-none"
        classList={{
          "bg-black/60": !isBright(),
          "bg-black/70": isBright(),
          "scene-bright": isBright(),
        }}
        style={{
          transition: "background-color 1200ms ease",
        }}
      >
        {/* ── Main pause panel ───────────────────────── */}
        <Show when={panel() === "pause"}>
          <div class="flex flex-col items-center gap-4 w-72">
            <h1 class="text-white font-bold text-3xl tracking-wide mb-2 drop-shadow">
              Paused
            </h1>
            <button
              class="btn btn-primary w-full text-base"
              onClick={() => props.menu.resume()}
            >
              Resume
            </button>
            <button
              class="btn btn-soft btn-secondary w-full text-base"
              onClick={() => setPanel("settings")}
            >
              Settings
            </button>
            <button
              class="btn btn-soft btn-error w-full text-base"
              onClick={() => props.menu.openQuitConfirm()}
            >
              Quit to title
            </button>
          </div>
        </Show>

        <Show when={quitConfirmOpen()}>
          <div class="absolute inset-0 bg-black/70 flex items-center justify-center px-4">
            <div class="w-full max-w-sm rounded-lg border border-white/15 bg-zinc-900/95 p-4">
              <h3 class="text-white text-lg font-bold">
                Quit to title
              </h3>
              <p class="text-white/70 text-sm mt-1">
                Save this world before leaving gameplay?
              </p>
              <div class="mt-4 grid grid-cols-3 gap-2">
                <button
                  class="btn btn-primary btn-sm"
                  onClick={() =>
                    props.menu.submitQuitIntent("save")
                  }
                >
                  Save
                </button>
                <button
                  class="btn btn-soft btn-warning btn-sm"
                  onClick={() =>
                    props.menu.submitQuitIntent("discard")
                  }
                >
                  Discard
                </button>
                <button
                  class="btn btn-soft btn-secondary btn-sm"
                  onClick={() =>
                    props.menu.submitQuitIntent("cancel")
                  }
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </Show>

        {/* ── Settings ↔ Shaderpacks sliding area ──── */}
        <Show when={inSettingsArea()}>
          <div class="overflow-hidden w-80">
            <div
              class="flex transition-transform duration-300 ease-out"
              style={{
                transform:
                  panel() === "shaderpacks"
                    ? "translateX(-100%)"
                    : "translateX(0)",
              }}
            >
              {/* ─── Settings panel (left) ─────────── */}
              <div class="w-80 shrink-0 flex flex-col gap-6">
                {/* Header */}
                <div class="flex items-center gap-3 mb-1">
                  <button
                    class="flex items-center gap-1 text-white/50 hover:text-white/90 text-sm transition-colors duration-150 cursor-pointer"
                    onClick={() => setPanel("pause")}
                  >
                    <ChevronLeft
                      size={18}
                      stroke-width={2}
                    />
                    <span>Back</span>
                  </button>
                  <h2 class="text-white font-bold text-2xl tracking-wide">
                    Settings
                  </h2>
                </div>

                {/* Brightness */}
                <div class="setting-row">
                  <div class="flex justify-between text-white/90 text-sm font-mono mb-1.5">
                    <span>Brightness</span>
                    <span>{brightness()}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="200"
                    step="1"
                    value={brightness()}
                    class="range range-primary w-full"
                    onInput={onSliderInput}
                    onPointerDown={() => setDragging(true)}
                    onPointerUp={() => {
                      setDragging(false);
                      setShowSnapHint(false);
                    }}
                  />
                  <div class="flex justify-between text-white/40 text-xs mt-0.5">
                    <span>Dark</span>
                    <span>Normal</span>
                    <span>Bright</span>
                  </div>
                  <p
                    class="text-white/35 text-xs text-center mt-1.5 select-none transition-opacity duration-150"
                    classList={{
                      "opacity-0":
                        !showSnapHint() || !dragging(),
                    }}
                  >
                    Hold <kbd class="kbd kbd-xs">Alt</kbd>{" "}
                    to drag freely without snapping
                  </p>
                </div>

                {/* HDR */}
                <div class="setting-row">
                  <label
                    class="flex items-center justify-between text-white/90 text-sm font-mono select-none"
                    classList={{
                      "cursor-pointer":
                        Settings.hdrSupported,
                      "opacity-50 cursor-not-allowed":
                        !Settings.hdrSupported,
                    }}
                  >
                    <span class="flex flex-col gap-0.5">
                      <span>HDR Rendering</span>
                      <Show when={!Settings.hdrSupported}>
                        <span class="text-white/40 text-xs">
                          Not supported by this device
                        </span>
                      </Show>
                    </span>
                    <input
                      type="checkbox"
                      class="toggle toggle-primary"
                      classList={{
                        "cursor-not-allowed":
                          !Settings.hdrSupported,
                      }}
                      checked={hdr()}
                      disabled={!Settings.hdrSupported}
                      onChange={(e) => {
                        if (!Settings.hdrSupported) return;
                        setHdr(e.currentTarget.checked);
                      }}
                    />
                  </label>
                </div>

                {/* Shaderpack — clickable row with chevron */}
                <div
                  class="setting-row cursor-pointer"
                  onClick={() => setPanel("shaderpacks")}
                >
                  <div class="flex items-center justify-between">
                    <div class="flex flex-col gap-0.5">
                      <span class="text-white/90 text-sm font-mono">
                        Iris Shaderpack
                      </span>
                      <span class="text-white/50 text-xs">
                        {shaderpackStatus()}
                      </span>
                    </div>
                    <ChevronRight
                      size={20}
                      class="text-white/40"
                      stroke-width={2}
                    />
                  </div>
                </div>

                <button
                  class="btn btn-primary w-full mt-2"
                  onClick={() => setPanel("pause")}
                >
                  Done
                </button>
              </div>

              {/* ─── Shaderpacks panel (right) ─────── */}
              <div class="w-80 shrink-0 flex flex-col gap-4 pl-6">
                {/* Header */}
                <div class="flex items-center gap-3 mb-1">
                  <button
                    class="flex items-center gap-1 text-white/50 hover:text-white/90 text-sm transition-colors duration-150 cursor-pointer"
                    onClick={() => setPanel("settings")}
                  >
                    <ChevronLeft
                      size={18}
                      stroke-width={2}
                    />
                    <span>Settings</span>
                  </button>
                  <h2 class="text-white font-bold text-2xl tracking-wide">
                    Shaderpacks
                  </h2>
                </div>

                {/* Active indicator */}
                <div class="setting-row py-2">
                  <div class="flex items-center justify-between text-sm font-mono">
                    <span class="text-white/60">
                      Active
                    </span>
                    <span class="text-white/90 truncate ml-2">
                      {activePackName() ?? "None"}
                    </span>
                  </div>
                </div>

                {/* Pack list */}
                <div class="setting-row p-0 overflow-hidden">
                  <Show
                    when={!libraryScanning()}
                    fallback={
                      <p class="text-white/40 text-xs text-center py-6">
                        Scanning library…
                      </p>
                    }
                  >
                    <Show
                      when={libraryPacks().length > 0}
                      fallback={
                        <p class="text-white/40 text-xs text-center py-6 px-4">
                          No shaderpacks in library. Use the
                          button below to add one.
                        </p>
                      }
                    >
                      <div class="flex flex-col max-h-60 overflow-y-auto">
                        <For each={libraryPacks()}>
                          {(name) => {
                            const isActive = () =>
                              activePackName() === name;
                            const isHighlighted = () =>
                              highlightedPack() === name;
                            return (
                              <div
                                class="flex items-center justify-between px-3 py-2 transition-colors duration-150"
                                classList={{
                                  "bg-primary/15 border-l-2 border-primary":
                                    isActive(),
                                  "hover:bg-white/5":
                                    !isActive(),
                                  "ring-2 ring-primary ring-inset animate-pulse":
                                    isHighlighted(),
                                }}
                              >
                                <span class="text-white/80 text-xs font-mono truncate flex-1">
                                  {name}
                                </span>
                                <Show
                                  when={isActive()}
                                  fallback={
                                    <button
                                      class="btn btn-soft btn-primary btn-xs ml-2 shrink-0"
                                      onClick={() =>
                                        onLoadFromLibrary(
                                          name,
                                        )
                                      }
                                    >
                                      Apply
                                    </button>
                                  }
                                >
                                  <span class="text-primary text-xs font-semibold ml-2 shrink-0">
                                    Active
                                  </span>
                                </Show>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </div>

                <Show when={libraryError()}>
                  {(msg) => (
                    <p class="text-xs text-red-300">
                      {msg()}
                    </p>
                  )}
                </Show>
                <Show when={shaderpackError()}>
                  {(msg) => (
                    <p class="text-xs text-red-300">
                      {msg()}
                    </p>
                  )}
                </Show>

                {/* Actions */}
                <div class="flex gap-2">
                  {import.meta.isTauri ? (
                    <button
                      class="btn btn-soft btn-secondary btn-sm flex-1"
                      onClick={onAddFolder}
                    >
                      <Plus size={14} stroke-width={2.5} />
                      Add Folder
                    </button>
                  ) : (
                    <button
                      class="btn btn-soft btn-secondary btn-sm flex-1"
                      onClick={onAddZip}
                    >
                      <Plus size={14} stroke-width={2.5} />
                      Add Files
                    </button>
                  )}
                  <Show when={activePackName()}>
                    <button
                      class="btn btn-soft btn-error btn-sm"
                      onClick={onDisableShaderpack}
                    >
                      Disable
                    </button>
                  </Show>
                </div>

                {/* Hidden file inputs for web */}
                {!import.meta.isTauri && (
                  <>
                    <input
                      ref={folderInputRef}
                      type="file"
                      multiple
                      class="hidden"
                      onChange={(e) => {
                        onWebFolderPicked(e).catch(
                          onWebPickerError,
                        );
                      }}
                    />
                    <input
                      ref={zipInputRef}
                      type="file"
                      accept=".zip"
                      class="hidden"
                      onChange={(e) => {
                        onWebZipPicked(e).catch(
                          onWebPickerError,
                        );
                      }}
                    />
                  </>
                )}

                <button
                  class="btn btn-primary w-full"
                  onClick={() => setPanel("settings")}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}
