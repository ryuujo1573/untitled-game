import { invoke } from "@tauri-apps/api/core";
import type { Camera } from "~/engine/rendering/camera";
import type { InputBackend } from "./input-backend";

/**
 * NativeInputManager — native input for Tauri 2.
 *
 * Cursor lock calls a single Rust command that invokes:
 *   window.set_cursor_grab(true)   → macOS: CGAssociateMouseAndMouseCursorPosition(false)
 *                                     true OS-level lock; cursor position dissociated from
 *                                     physical movement while raw deltas still flow through
 *   window.set_cursor_visible(false) — both in one IPC round-trip
 *
 * Mouse deltas come from DOM mousemove movementX/Y. When cursor is OS-locked,
 * WKWebView on macOS receives raw CoreGraphics delta events — no pointer ballistics,
 * no manual cursor recentering needed.
 */
export class NativeInputManager implements InputBackend {
  private locked = false;
  private pendingDx = 0;
  private pendingDy = 0;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.pendingDx += e.movementX;
      this.pendingDy += e.movementY;
    });

    window.addEventListener("blur", () => {
      if (this.locked) this.unlock();
    });
  }

  async requestLock(): Promise<void> {
    try {
      await invoke("set_cursor_grab", { grab: true });
      this.locked = true;
      document.body.style.cursor = "none";
      this.canvas.focus();
    } catch (e) {
      console.error("Failed to grab cursor (native)", e);
    }
  }

  async unlock(): Promise<void> {
    // Drop locked flag first so in-flight mousemove events are ignored.
    this.locked = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
    document.body.style.cursor = "";
    try {
      await invoke("set_cursor_grab", { grab: false });
    } catch {}
  }

  isLocked(): boolean {
    return this.locked;
  }

  update(
    camera: Camera,
    sensitivityMultiplier: number,
  ): void {
    if (
      !this.locked ||
      (this.pendingDx === 0 && this.pendingDy === 0)
    )
      return;

    const sensitivity = sensitivityMultiplier;
    // Clamp outlier spikes that can occur on lock/unlock transitions.
    const maxDelta = 200;
    const dx = Math.max(
      -maxDelta,
      Math.min(maxDelta, this.pendingDx),
    );
    const dy = Math.max(
      -maxDelta,
      Math.min(maxDelta, this.pendingDy),
    );

    camera.rotate(dx * sensitivity, dy * sensitivity);
    this.pendingDx = 0;
    this.pendingDy = 0;
  }
}
