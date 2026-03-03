import { createSignal, createEffect, onCleanup, Show, For } from "solid-js";
import { render } from "solid-js/web";
import { ChevronLeft } from "lucide-solid";
import { Settings } from "~/settings";
import {
  getShaderpackStateSnapshot,
  loadShaderpack,
  pickAndLoadShaderpackFolder,
  pickAndLoadShaderpackZip,
  subscribeShaderpackRuntime,
  unloadShaderpack,
} from "~/shaderpack/runtime";
import {
  getLibraryPath,
  loadPackFromLibrary,
  pickLibraryDirectory,
  scanLibrary,
} from "~/shaderpack/library";

// ── Constants ──────────────────────────────────────────────────
/** Slider values (0–200) that the brightness bar snaps to. */
const SNAP_POINTS = [0, 25, 50, 75, 100, 125, 150, 175, 200];
/** How close (in slider units) the thumb must be before it snaps. */
const SNAP_THRESHOLD = 8;

// ── Shared reactive state (readable from outside Solid) ───────
const [paused, setPaused] = createSignal(false);
const [panel, setPanel] = createSignal<"pause" | "settings">("pause");

/**
 * Scene luminance [0-255] sampled from the WebGL canvas each frame while
 * paused.  Drives the adaptive overlay/row tint.
 */
const [sceneLuma, setSceneLuma] = createSignal(0);

/** Called by the renderer each frame while paused. */
export function updateSceneLuma(luma: number): void {
  setSceneLuma(luma);
}

/**
 * Public controller – same shape that InputManager already uses.
 * Created once; the Solid component tree reads the signals it exposes.
 */
export class PauseMenu {
  private readonly onResume: () => void;

  constructor(onResume: () => void) {
    this.onResume = onResume;
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
    setPanel("pause"); // always reset to main panel
  }

  resume(): void {
    setPaused(false);
    this.onResume();
  }

  /** Mount the Solid component tree into the given container. */
  mount(container: HTMLElement): void {
    render(() => <PauseOverlay menu={this} />, container);
  }
}

// ── Solid component ───────────────────────────────────────────
function PauseOverlay(props: { menu: PauseMenu }) {
  // ── Brightness state ────────────────────────────────────────
  const initPct = Math.round(Settings.brightness * 100);
  const [brightness, setBrightness] = createSignal(initPct);
  const [showSnapHint, setShowSnapHint] = createSignal(false);
  const [altPressed, setAltPressed] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);

  // ── HDR state ───────────────────────────────────────────────
  const [hdr, setHdr] = createSignal(Settings.hdr);
  const [shaderpackStatus, setShaderpackStatus] = createSignal("No shaderpack loaded");
  const [shaderpackError, setShaderpackError] = createSignal<string | null>(null);

  const [libraryPath, setLibraryPath] = createSignal<string | null>(getLibraryPath());
  const [libraryPacks, setLibraryPacks] = createSignal<string[]>([]);
  const [libraryError, setLibraryError] = createSignal<string | null>(null);
  const [libraryScanning, setLibraryScanning] = createSignal(false);

  let folderInputRef: HTMLInputElement | undefined;
  let zipInputRef: HTMLInputElement | undefined;

  const refreshShaderpackStatus = () => {
    const snapshot = getShaderpackStateSnapshot();
    const active = snapshot.active;
    if (!active) {
      setShaderpackStatus("No shaderpack loaded");
      return;
    }
    const overrides = snapshot.stageStatuses.filter((s) => s.mode === "override").length;
    const total = snapshot.stageStatuses.length;
    setShaderpackStatus(`${active.name} (${overrides}/${total} overrides)`);
  };

  // ── Adaptive tint: true when the rendered scene behind the overlay is bright
  const isBright = () => sceneLuma() > 160;

  // ── Alt-key tracking ────────────────────────────────────────
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Alt") return;
    if (panel() === "settings") e.preventDefault();
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

  // ── Slider input handler ────────────────────────────────────
  const onSliderInput = (e: InputEvent) => {
    const raw = Number((e.currentTarget as HTMLInputElement).value);
    let v = raw;

    if (!altPressed()) {
      const nearest = SNAP_POINTS.reduce((a, b) =>
        Math.abs(b - raw) < Math.abs(a - raw) ? b : a,
      );
      if (Math.abs(nearest - raw) <= SNAP_THRESHOLD) {
        v = nearest;
        // Visually snap the thumb.
        (e.currentTarget as HTMLInputElement).value = String(v);
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

  // ── Persist HDR changes ─────────────────────────────────────
  createEffect(() => {
    Settings.hdr = hdr();
    Settings.save();
  });

  // ── Library scan: run whenever the settings panel opens with a path set ──
  const doScanLibrary = async () => {
    setLibraryScanning(true);
    setLibraryError(null);
    try {
      setLibraryPacks(await scanLibrary());
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e));
      setLibraryPacks([]);
    } finally {
      setLibraryScanning(false);
    }
  };

  createEffect(() => {
    if (panel() === "settings" && libraryPath()) {
      doScanLibrary().catch(() => {});
    }
  });

  const onPickLibrary = async () => {
    setLibraryError(null);
    try {
      const chosen = await pickLibraryDirectory();
      if (chosen) {
        setLibraryPath(chosen);
        await doScanLibrary();
      }
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e));
    }
  };

  const onLoadFromLibrary = async (name: string) => {
    setShaderpackError(null);
    try {
      await loadPackFromLibrary(name);
    } catch (e) {
      setShaderpackError(e instanceof Error ? e.message : String(e));
    }
  };

  const onLoadFolder = async () => {
    setShaderpackError(null);
    try {
      if (import.meta.isTauri) {
        await pickAndLoadShaderpackFolder();
      } else {
        folderInputRef?.click();
      }
    } catch (e) {
      setShaderpackError(e instanceof Error ? e.message : String(e));
    }
  };

  const onLoadZip = async () => {
    setShaderpackError(null);
    try {
      if (import.meta.isTauri) {
        await pickAndLoadShaderpackZip();
      } else {
        zipInputRef?.click();
      }
    } catch (e) {
      setShaderpackError(e instanceof Error ? e.message : String(e));
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
    await loadShaderpack({ kind: "browser-files", files: Array.from(files) });
    input.value = "";
  };

  const onWebZipPicked = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    // Browser ZIP parsing is not implemented yet; this still routes through the
    // same runtime path so users get a clear diagnostic.
    await loadShaderpack({ kind: "browser-files", files: Array.from(files) });
    input.value = "";
  };

  const onWebPickerError = (e: unknown) => {
    setShaderpackError(e instanceof Error ? e.message : String(e));
  };

  // ── Template ────────────────────────────────────────────────
  return (
    <Show when={paused()}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm select-none"
        classList={{
          "bg-black/60": !isBright(),
          "bg-black/70": isBright(),
          "scene-bright": isBright(),
        }}
        style={{ transition: "background-color 1200ms ease" }}
      >
        {/* ── Main pause panel ─────────────────────────── */}
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
              onClick={() => location.reload()}
            >
              Quit to title
            </button>
          </div>
        </Show>

        {/* ── Settings sub-panel ───────────────────────── */}
        <Show when={panel() === "settings"}>
          <div class="flex flex-col gap-6 w-80">
            {/* Header */}
            <div class="flex items-center gap-3 mb-1">
              <button
                class="flex items-center gap-1 text-white/50 hover:text-white/90 text-sm transition-colors duration-150 cursor-pointer"
                onClick={() => setPanel("pause")}
              >
                <ChevronLeft size={18} stroke-width={2} />
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
                classList={{ "opacity-0": !showSnapHint() || !dragging() }}
              >
                Hold <kbd class="kbd kbd-xs">Alt</kbd> to drag freely without
                snapping
              </p>
            </div>

            {/* HDR */}
            <div class="setting-row">
              <label
                class="flex items-center justify-between text-white/90 text-sm font-mono select-none"
                classList={{
                  "cursor-pointer": Settings.hdrSupported,
                  "opacity-50 cursor-not-allowed": !Settings.hdrSupported,
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
                    "cursor-not-allowed": !Settings.hdrSupported,
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

            {/* Shaderpack */}
            <div class="setting-row">
              <div class="flex justify-between text-white/90 text-sm font-mono mb-1.5">
                <span>Iris Shaderpack</span>
                <span class="text-white/60 text-[11px]">{shaderpackStatus()}</span>
              </div>

              {/* Library – Tauri only */}
              {import.meta.isTauri && (
                <div class="mb-3">
                  <Show
                    when={libraryPath()}
                    fallback={
                      <button
                        class="btn btn-soft btn-secondary btn-sm w-full"
                        onClick={onPickLibrary}
                      >
                        Set Shaderpack Library Folder
                      </button>
                    }
                  >
                    {/* Path row */}
                    <div class="flex items-center gap-2 mb-2">
                      <span class="text-white/40 text-[11px] font-mono truncate flex-1" title={libraryPath()!}>
                        {libraryPath()}
                      </span>
                      <button
                        class="btn btn-soft btn-secondary btn-xs shrink-0"
                        onClick={onPickLibrary}
                      >
                        Change
                      </button>
                    </div>

                    {/* Pack list */}
                    <Show when={!libraryScanning()} fallback={
                      <p class="text-white/40 text-xs text-center py-2">Scanning…</p>
                    }>
                      <Show
                        when={libraryPacks().length > 0}
                        fallback={
                          <p class="text-white/40 text-xs text-center py-2">
                            No shaderpacks found. Drop folders into the library directory to add them.
                          </p>
                        }
                      >
                        <div class="flex flex-col gap-0.5 max-h-40 overflow-y-auto pr-1">
                          <For each={libraryPacks()}>
                            {(name) => (
                              <div class="flex items-center justify-between rounded px-2 py-1 hover:bg-white/5">
                                <span class="text-white/80 text-xs font-mono truncate flex-1">{name}</span>
                                <button
                                  class="btn btn-soft btn-primary btn-xs ml-2 shrink-0"
                                  onClick={() => onLoadFromLibrary(name)}
                                >
                                  Load
                                </button>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </Show>

                    <button
                      class="btn btn-ghost btn-xs text-white/40 hover:text-white/70 mt-1.5 w-full"
                      onClick={() => doScanLibrary().catch(() => {})}
                    >
                      Refresh
                    </button>
                  </Show>
                  <Show when={libraryError()}>
                    {(msg) => <p class="text-xs text-red-300 mt-1">{msg()}</p>}
                  </Show>
                </div>
              )}

              {/* Ad-hoc load */}
              <div class="flex gap-2">
                <button class="btn btn-soft btn-primary btn-sm flex-1" onClick={onLoadFolder}>
                  Load Folder
                </button>
                <button class="btn btn-soft btn-primary btn-sm flex-1" onClick={onLoadZip}>
                  Load ZIP
                </button>
                <button class="btn btn-soft btn-error btn-sm" onClick={onDisableShaderpack}>
                  Disable
                </button>
              </div>
              <Show when={shaderpackError()}>
                {(msg) => <p class="text-xs text-red-300 mt-1.5">{msg()}</p>}
              </Show>
              <input
                ref={folderInputRef}
                type="file"
                multiple
                class="hidden"
                onChange={(e) => {
                  onWebFolderPicked(e).catch(onWebPickerError);
                }}
              />
              <input
                ref={zipInputRef}
                type="file"
                accept=".zip"
                class="hidden"
                onChange={(e) => {
                  onWebZipPicked(e).catch(onWebPickerError);
                }}
              />
            </div>

            <button
              class="btn btn-primary w-full mt-2"
              onClick={() => setPanel("pause")}
            >
              Done
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
