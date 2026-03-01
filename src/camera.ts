import { mat4, vec3 } from "gl-matrix";

export class Camera {
  position: vec3;
  yaw: number; // radians – rotation around Y axis
  pitch: number; // radians – rotation around X axis

  private readonly sensitivity = 0.002;
  private readonly speed = 8.0; // units per second

  constructor() {
    this.position = vec3.fromValues(32, 20, 32);
    this.yaw = 0;
    this.pitch = -0.3;
  }

  /** Returns the unit forward vector derived from yaw + pitch. */
  getForward(): vec3 {
    return vec3.fromValues(
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      -Math.cos(this.pitch) * Math.cos(this.yaw),
    );
  }

  /** Returns the unit right vector (always horizontal). */
  getRight(): vec3 {
    return vec3.fromValues(Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  rotate(dx: number, dy: number): void {
    this.yaw += dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    // Clamp pitch to avoid flipping
    const limit = (89 * Math.PI) / 180;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  moveForward(dt: number): void {
    const fwd = this.getForward();
    vec3.scaleAndAdd(this.position, this.position, fwd, this.speed * dt);
  }

  moveRight(dt: number): void {
    const right = this.getRight();
    vec3.scaleAndAdd(this.position, this.position, right, this.speed * dt);
  }

  moveUp(dt: number): void {
    this.position[1] += this.speed * dt;
  }

  getViewMatrix(): mat4 {
    const target = vec3.create();
    vec3.add(target, this.position, this.getForward());
    const view = mat4.create();
    mat4.lookAt(view, this.position, target, vec3.fromValues(0, 1, 0));
    return view;
  }

  getProjectionMatrix(aspect: number): mat4 {
    const proj = mat4.create();
    mat4.perspective(proj, (70 * Math.PI) / 180, aspect, 0.1, 500.0);
    return proj;
  }
}
