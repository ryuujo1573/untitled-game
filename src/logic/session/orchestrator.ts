import { initializeCanvas } from "~/engine/rendering/canvas";
import { InMemorySaveStore } from "~/logic/session/in-memory-save-store";
import { createGeneratedSave } from "~/logic/session/session-codec";
import type { GameSaveV1 } from "~/logic/session/session-types";
import type { QuitToTitleIntent } from "~/ui/pause-menu";
import { WebGLRenderer } from "~/engine/rendering/renderer";
import type { IRenderer } from "~/engine/rendering/renderer-interface";
import {
  mountTitleScreen,
  type TitleScreenController,
} from "~/ui/title-screen";
import { WebGPURenderer } from "~/engine/webgpu/renderer";

type BackendKind = "webgpu" | "webgl";

function stripManagedFields(
  save: GameSaveV1,
): Omit<
  GameSaveV1,
  "id" | "name" | "createdAtMs" | "updatedAtMs"
> {
  return {
    version: save.version,
    world: save.world,
    player: save.player,
    environment: save.environment,
    entities: save.entities,
    meta: save.meta,
  };
}

export class SessionOrchestrator {
  private readonly canvas: HTMLCanvasElement;
  private readonly titleRoot: HTMLElement;
  private readonly store = new InMemorySaveStore();

  private title: TitleScreenController | null = null;
  private selectedSaveId: string | null = null;
  private activeRenderer: IRenderer | null = null;
  private backend: BackendKind | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    titleRoot: HTMLElement,
  ) {
    this.canvas = canvas;
    this.titleRoot = titleRoot;
  }

  start(): void {
    this.title = mountTitleScreen(
      this.titleRoot,
      { saves: [], selectedSaveId: null },
      {
        onSelectSave: (id) => {
          this.selectedSaveId = id;
          this.refreshTitle();
        },
        onContinue: () => {
          if (!this.selectedSaveId) return;
          this.playSave(this.selectedSaveId).catch(
            (err) => {
              console.error(
                "Failed to continue save:",
                err,
              );
            },
          );
        },
        onCreateWorld: () => {
          this.createWorldAndPlay().catch((err) => {
            console.error("Failed to create world:", err);
          });
        },
        onRename: () => {
          this.renameSelected();
        },
        onDelete: () => {
          this.deleteSelected();
        },
      },
    );

    this.setMode("title");
    this.refreshTitle();
  }

  destroy(): void {
    this.activeRenderer?.destroy();
    this.activeRenderer = null;
    this.title?.destroy();
    this.title = null;
  }

  private setMode(mode: "title" | "playing"): void {
    document.body.dataset.appMode = mode;
  }

  private refreshTitle(): void {
    this.title?.setState({
      saves: this.store.list(),
      selectedSaveId: this.selectedSaveId,
    });
  }

  private async createWorldAndPlay(): Promise<void> {
    const worldName = this.nextWorldName();
    const save = this.store.create(
      worldName,
      createGeneratedSave(worldName),
    );
    this.selectedSaveId = save.id;
    this.refreshTitle();
    await this.playSave(save.id);
  }

  private nextWorldName(): string {
    const existingNames = new Set(
      this.store.list().map((s) => s.name),
    );
    let index = 1;
    while (existingNames.has(`World ${index}`)) index++;
    return `World ${index}`;
  }

  private renameSelected(): void {
    if (!this.selectedSaveId) return;
    const current = this.store.get(this.selectedSaveId);
    if (!current) return;

    const name = window.prompt("Rename save", current.name);
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    this.store.rename(this.selectedSaveId, trimmed);
    this.refreshTitle();
  }

  private deleteSelected(): void {
    if (!this.selectedSaveId) return;
    const current = this.store.get(this.selectedSaveId);
    if (!current) return;

    const confirmed = window.confirm(
      `Delete save "${current.name}"?`,
    );
    if (!confirmed) return;

    this.store.remove(this.selectedSaveId);
    const list = this.store.list();
    this.selectedSaveId = list[0]?.id ?? null;
    this.refreshTitle();
  }

  private async playSave(saveId: string): Promise<void> {
    const save = this.store.get(saveId);
    if (!save) return;

    this.setMode("playing");
    this.activeRenderer?.destroy();
    this.activeRenderer = null;

    const hooks = {
      onQuitRequested: (intent: QuitToTitleIntent) =>
        this.handleQuit(intent),
    };

    try {
      const renderer = await this.startRendererSession(
        save,
        hooks,
      );
      this.activeRenderer = renderer;
    } catch (err) {
      this.setMode("title");
      this.refreshTitle();
      throw err;
    }
  }

  private async startRendererSession(
    save: GameSaveV1,
    hooks: {
      onQuitRequested: (intent: QuitToTitleIntent) => void;
    },
  ): Promise<IRenderer> {
    if (this.backend === "webgpu") {
      const renderer = new WebGPURenderer(this.canvas);
      await renderer.startSession(save, hooks);
      return renderer;
    }

    if (this.backend === "webgl") {
      const gl = initializeCanvas("webglCanvas");
      if (!gl) throw new Error("WebGL2 is not supported");
      const renderer = new WebGLRenderer(gl);
      await renderer.startSession(save, hooks);
      return renderer;
    }

    if (typeof navigator !== "undefined" && navigator.gpu) {
      const renderer = new WebGPURenderer(this.canvas);
      try {
        await renderer.startSession(save, hooks);
        this.backend = "webgpu";
        return renderer;
      } catch (err) {
        renderer.destroy();
        console.warn(
          "WebGPU failed, falling back to WebGL2:",
          err,
        );
      }
    }

    const gl = initializeCanvas("webglCanvas");
    if (!gl)
      throw new Error(
        "Neither WebGPU nor WebGL2 is available",
      );
    const renderer = new WebGLRenderer(gl);
    await renderer.startSession(save, hooks);
    this.backend = "webgl";
    return renderer;
  }

  private handleQuit(intent: QuitToTitleIntent): void {
    if (intent === "cancel") return;
    if (!this.activeRenderer) return;

    if (intent === "save" && this.selectedSaveId) {
      try {
        const snapshot =
          this.activeRenderer.captureSession();
        this.store.update(
          this.selectedSaveId,
          stripManagedFields(snapshot),
        );
      } catch (err) {
        console.error(
          "Failed to save session before quitting to title:",
          err,
        );
      }
    }

    this.activeRenderer.destroy();
    this.activeRenderer = null;
    this.setMode("title");
    this.refreshTitle();
  }
}

export function startSessionOrchestrator(
  canvas: HTMLCanvasElement,
): SessionOrchestrator {
  const titleRoot = document.getElementById("title-root");
  if (!titleRoot) {
    throw new Error("Missing #title-root mount node");
  }

  const orchestrator = new SessionOrchestrator(
    canvas,
    titleRoot,
  );
  orchestrator.start();
  return orchestrator;
}
