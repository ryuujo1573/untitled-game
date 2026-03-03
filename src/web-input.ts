import { Camera } from "./camera";
import { InputBackend } from "./input-backend";

/**
 * WebInputManager handles standard pointer lock behavior for browsers.
 */
export class WebInputManager implements InputBackend {
  private canvas: HTMLCanvasElement;
  private locked = false;
  private skipEvents = 0;
  private dx = 0;
  private dy = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) {
        this.skipEvents = 5;
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      if (this.skipEvents > 0) {
        this.skipEvents--;
        return;
      }

      this.dx += e.movementX;
      this.dy += e.movementY;
    });
  }

  requestLock(): void {
    const canPointerLock =
      typeof this.canvas.requestPointerLock ===
        "function" && "pointerLockElement" in document;

    if (!canPointerLock) return;

    try {
      const maybePromise = this.canvas.requestPointerLock();
      if (
        maybePromise &&
        typeof (maybePromise as Promise<void>).then ===
          "function"
      ) {
        (maybePromise as Promise<void>).catch(() => {
          console.error("Pointer lock promise rejected");
        });
      }
    } catch (e) {
      console.error("Pointer lock failed", e);
    }
  }

  unlock(): void {
    document.exitPointerLock();
  }

  isLocked(): boolean {
    return this.locked;
  }

  update(
    camera: Camera,
    sensitivityMultiplier: number,
  ): void {
    if (!this.locked) return;

    if (this.dx !== 0 || this.dy !== 0) {
      const webSensitivity = 1.0 * sensitivityMultiplier;

      // Standard clamping for web deltas
      const maxDelta = 120;
      const finalDx = Math.max(
        -maxDelta,
        Math.min(maxDelta, this.dx),
      );
      const finalDy = Math.max(
        -maxDelta,
        Math.min(maxDelta, this.dy),
      );

      camera.rotate(
        finalDx * webSensitivity,
        finalDy * webSensitivity,
      );
      this.dx = 0;
      this.dy = 0;
    }
  }
}
