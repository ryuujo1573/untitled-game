import { vec3 } from "gl-matrix";
import { Camera } from "./camera";
import { Physics } from "./physics";

/**
 * Manages keyboard + pointer-lock mouse input.
 * Computes a horizontal wish-direction each frame and delegates
 * movement + jumping to the Physics system.
 */
export class InputManager {
  private keys = new Set<string>();
  private camera: Camera;
  private physics: Physics;
  private pointerLocked = false;
  /**
   * After (re-)acquiring pointer lock, skip this many mousemove events.
   * Browsers queue up accumulated mouse deltas from while the window was
   * unfocused and flush them the moment the pointer is locked again, causing
   * a violent camera sweep.  Draining a few frames eliminates that burst.
   */
  private skipMouseEvents = 0;

  // Pre-allocated scratch vectors to avoid per-frame GC pressure.
  private wish = vec3.create();

  constructor(canvas: HTMLCanvasElement, camera: Camera, physics: Physics) {
    this.camera = camera;
    this.physics = physics;

    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      // Prevent Space from scrolling the page when not pointer-locked.
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    // Clear held keys when the window loses focus so they don't stay
    // "pressed" when the user alt+tabs away and comes back.
    window.addEventListener("blur", () => this.keys.clear());

    canvas.addEventListener("click", () => canvas.requestPointerLock());

    document.addEventListener("pointerlockchange", () => {
      const wasLocked = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === canvas;

      if (!this.pointerLocked) {
        // Lost lock (alt+tab, Escape, etc.) – clear key state so no
        // movement action stays active while the window is unfocused.
        this.keys.clear();
      } else if (!wasLocked) {
        // Just re-acquired lock – schedule skip of the next few mouse
        // events to drain any queued delta burst from the OS.
        this.skipMouseEvents = 5;
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      if (this.skipMouseEvents > 0) {
        this.skipMouseEvents--;
        return;
      }
      this.camera.rotate(e.movementX, e.movementY);
    });
  }

  /** Call once per frame – feeds wish direction and jump into Physics. */
  update(): void {
    const fwd = this.camera.getFlatForward();
    const right = this.camera.getRight();

    // Build wish direction from held keys.
    vec3.set(this.wish, 0, 0, 0);
    if (this.keys.has("KeyW")) vec3.scaleAndAdd(this.wish, this.wish, fwd, 1);
    if (this.keys.has("KeyS")) vec3.scaleAndAdd(this.wish, this.wish, fwd, -1);
    if (this.keys.has("KeyD")) vec3.scaleAndAdd(this.wish, this.wish, right, 1);
    if (this.keys.has("KeyA"))
      vec3.scaleAndAdd(this.wish, this.wish, right, -1);

    // Normalise diagonal movement so it isn't faster than cardinal.
    if (vec3.length(this.wish) > 0) vec3.normalize(this.wish, this.wish);

    // Jump request is handled inside Physics (only fires when onGround).
    if (this.keys.has("Space")) this.physics.jump();

    this.physics.update(this.wish[0], this.wish[2]);
  }
}
