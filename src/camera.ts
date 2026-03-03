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
    return vec3.fromValues(
      Math.cos(this.yaw),
      0,
      Math.sin(this.yaw),
    );
  }

  /** Forward projected onto the XZ plane – used for walking so pitch doesn't affect movement. */
  getFlatForward(): vec3 {
    return vec3.fromValues(
      Math.sin(this.yaw),
      0,
      -Math.cos(this.yaw),
    );
  }

  rotate(dx: number, dy: number): void {
    this.yaw += dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    // Clamp pitch to avoid flipping
    const limit = (89 * Math.PI) / 180;
    this.pitch = Math.max(
      -limit,
      Math.min(limit, this.pitch),
    );
  }

  moveForward(dt: number): void {
    const fwd = this.getForward();
    vec3.scaleAndAdd(
      this.position,
      this.position,
      fwd,
      this.speed * dt,
    );
  }

  moveRight(dt: number): void {
    const right = this.getRight();
    vec3.scaleAndAdd(
      this.position,
      this.position,
      right,
      this.speed * dt,
    );
  }

  moveUp(dt: number): void {
    this.position[1] += this.speed * dt;
  }

  getViewMatrix(): mat4 {
    const target = vec3.create();
    vec3.add(target, this.position, this.getForward());
    const view = mat4.create();
    mat4.lookAt(
      view,
      this.position,
      target,
      vec3.fromValues(0, 1, 0),
    );
    return view;
  }

  getProjectionMatrix(aspect: number): mat4 {
    const proj = mat4.create();
    mat4.perspective(
      proj,
      (70 * Math.PI) / 180,
      aspect,
      0.1,
      500.0,
    );
    return proj;
  }

  /**
   * Same field-of-view as getProjectionMatrix() but uses the zero-to-one
   * depth range expected by WebGPU (clip z ∈ [0, 1] rather than [-1, 1]).
   * Use this matrix when uploading to the WebGPU renderer's UBOs.
   */
  getProjectionMatrixZO(aspect: number): mat4 {
    const proj = mat4.create();
    mat4.perspectiveZO(
      proj,
      (70 * Math.PI) / 180,
      aspect,
      0.1,
      500.0,
    );
    return proj;
  }

  setPose(
    position: [number, number, number],
    yaw: number,
    pitch: number,
  ): void {
    this.position[0] = position[0];
    this.position[1] = position[1];
    this.position[2] = position[2];
    this.yaw = yaw;
    this.pitch = pitch;
  }

  getPose(): {
    position: [number, number, number];
    yaw: number;
    pitch: number;
  } {
    return {
      position: [
        this.position[0],
        this.position[1],
        this.position[2],
      ],
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }
}
