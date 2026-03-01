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

    canvas.addEventListener("click", () => canvas.requestPointerLock());

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });

    document.addEventListener("mousemove", (e) => {
      if (this.pointerLocked) this.camera.rotate(e.movementX, e.movementY);
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
