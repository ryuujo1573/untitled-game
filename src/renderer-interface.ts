import type { GameSaveV1 } from "~/game/session-types";
import type { QuitToTitleIntent } from "~/pause-menu";

export interface IRenderer {
  /** Initialise GPU resources and begin the RAF render loop. */
  startSession(
    initialSave: GameSaveV1,
    hooks: { onQuitRequested: (intent: QuitToTitleIntent) => void },
  ): Promise<void>;

  /** Capture a complete save snapshot from the live session. */
  captureSession(): GameSaveV1;

  /** Stop rendering and release event listeners/resources. */
  destroy(): void;
}
