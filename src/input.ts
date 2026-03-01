import { Camera } from "./camera";
import Time from "./time-manager";

/**
 * Manages keyboard + pointer-lock mouse input and drives the camera each frame.
 */
export class InputManager {
  private keys = new Set<string>();
  private canvas: HTMLCanvasElement;
  private camera: Camera;
  private pointerLocked = false;

  constructor(canvas: HTMLCanvasElement, camera: Camera) {
    this.canvas = canvas;
    this.camera = camera;

    window.addEventListener("keydown", (e) => this.keys.add(e.code));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    canvas.addEventListener("click", () => {
      canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });

    document.addEventListener("mousemove", (e) => {
      if (this.pointerLocked) {
        this.camera.rotate(e.movementX, e.movementY);
      }
    });
  }

  /** Call once per frame to move the camera based on held keys. */
  update(): void {
    const dt = Time.deltaTime;
    if (this.keys.has("KeyW")) this.camera.moveForward(dt);
    if (this.keys.has("KeyS")) this.camera.moveForward(-dt);
    if (this.keys.has("KeyD")) this.camera.moveRight(dt);
    if (this.keys.has("KeyA")) this.camera.moveRight(-dt);
    if (this.keys.has("Space")) this.camera.moveUp(dt);
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"))
      this.camera.moveUp(-dt);
  }
}
