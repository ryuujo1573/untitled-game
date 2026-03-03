import { vec3 } from "gl-matrix";
import { Camera } from "./camera";
import { World } from "./world/world";
import Time from "./time-manager";
import { BlockType } from "./world/block";

const GRAVITY = -28.0; // units/s²
const JUMP_SPEED = 9.0; // units/s upward on jump
const WALK_SPEED = 5.0; // units/s horizontal
const TERMINAL_VEL = -50.0; // minimum Y velocity
const EYE_HEIGHT = 1.6; // camera Y above feet
const HALF_W = 0.3; // player AABB half-width (X and Z)
const PLAYER_HEIGHT = 1.8; // player AABB full height (Y)

/**
 * Axis-aligned bounding-box physics for the player.
 *
 * Each frame, gravity is applied to Y velocity and then the player
 * is swept along each axis independently. If a sweep overlaps a solid
 * block the movement is undone and that velocity component is zeroed.
 * This prevents tunneling while keeping the implementation simple.
 */
export class Physics {
  /** World-space velocity in units/s. */
  velocity: vec3 = vec3.create();

  /** True when the player is standing on a solid surface. */
  onGround = false;

  /** Feet position – camera is at feet + EYE_HEIGHT. */
  private feet: vec3;

  constructor(
    private camera: Camera,
    private world: World,
  ) {
    // Derive feet from the camera's starting position.
    this.feet = vec3.fromValues(
      camera.position[0],
      camera.position[1] - EYE_HEIGHT,
      camera.position[2],
    );
  }

  /** Attempt a jump; only succeeds when standing on the ground. */
  jump(): void {
    if (this.onGround) {
      this.velocity[1] = JUMP_SPEED;
      this.onGround = false;
    }
  }

  /**
   * Advance physics by one frame.
   * @param wishX  Desired horizontal X velocity direction (−1 … 1, pre-normalised).
   * @param wishZ  Desired horizontal Z velocity direction (−1 … 1, pre-normalised).
   */
  update(wishX: number, wishZ: number): void {
    // Cap delta so that a long pause (tab hidden, breakpoint, etc.)
    // can't teleport the player through a block.
    const dt = Math.min(Time.deltaTime, 0.05);

    // ── Gravity (always applied so the player is probed down every frame) ──
    this.velocity[1] += GRAVITY * dt;
    if (this.velocity[1] < TERMINAL_VEL)
      this.velocity[1] = TERMINAL_VEL;

    // ── Horizontal wish velocity (instant, no friction sim for now) ────────
    this.velocity[0] = wishX * WALK_SPEED;
    this.velocity[2] = wishZ * WALK_SPEED;

    this.onGround = false;

    // ── Sweep X ─────────────────────────────────────────────────────────────
    this.feet[0] += this.velocity[0] * dt;
    if (this.collidesWorld()) {
      this.feet[0] -= this.velocity[0] * dt;
      this.velocity[0] = 0;
    }

    // ── Sweep Y ─────────────────────────────────────────────────────────────
    const velY = this.velocity[1];
    this.feet[1] += velY * dt;
    if (this.collidesWorld()) {
      this.feet[1] -= velY * dt;
      if (velY < 0) this.onGround = true; // hit something below → grounded
      this.velocity[1] = 0;
    }

    // ── Sweep Z ─────────────────────────────────────────────────────────────
    this.feet[2] += this.velocity[2] * dt;
    if (this.collidesWorld()) {
      this.feet[2] -= this.velocity[2] * dt;
      this.velocity[2] = 0;
    }

    // ── Sync camera to feet position ─────────────────────────────────────
    this.camera.position[0] = this.feet[0];
    this.camera.position[1] = this.feet[1] + EYE_HEIGHT;
    this.camera.position[2] = this.feet[2];
  }

  /**
   * Returns true if the player AABB (at the current feet position) overlaps
   * any solid block in the world.
   */
  private collidesWorld(): boolean {
    const minX = this.feet[0] - HALF_W;
    const maxX = this.feet[0] + HALF_W;
    const minY = this.feet[1];
    const maxY = this.feet[1] + PLAYER_HEIGHT;
    const minZ = this.feet[2] - HALF_W;
    const maxZ = this.feet[2] + HALF_W;

    // Integer block range that the AABB can touch.
    const bx0 = Math.floor(minX);
    const bx1 = Math.floor(maxX);
    const by0 = Math.floor(minY);
    const by1 = Math.floor(maxY);
    const bz0 = Math.floor(minZ);
    const bz1 = Math.floor(maxZ);

    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        for (let bz = bz0; bz <= bz1; bz++) {
          if (
            this.world.getBlock(bx, by, bz) !==
            BlockType.Air
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  getState(): {
    velocity: [number, number, number];
    onGround: boolean;
  } {
    return {
      velocity: [
        this.velocity[0],
        this.velocity[1],
        this.velocity[2],
      ],
      onGround: this.onGround,
    };
  }

  setState(state: {
    velocity: [number, number, number];
    onGround: boolean;
  }): void {
    this.velocity[0] = state.velocity[0];
    this.velocity[1] = state.velocity[1];
    this.velocity[2] = state.velocity[2];
    this.onGround = state.onGround;
    this.feet[0] = this.camera.position[0];
    this.feet[1] = this.camera.position[1] - EYE_HEIGHT;
    this.feet[2] = this.camera.position[2];
  }
}
