import { vec3 } from "gl-matrix";
import { Camera } from "./camera";
import { Physics } from "./physics";
import { World } from "./world/world";
import { BlockType } from "./world/block";
import { raycast } from "./raycaster";

/** Called after a block is placed or broken so the renderer can re-upload the chunk. */
export type BlockEditCallback = (wx: number, wy: number, wz: number) => void;

/** Cycle order for the held block type (press E to advance). */
const PLACE_CYCLE: BlockType[] = [
  BlockType.Dirt,
  BlockType.Grass,
  BlockType.Stone,
  BlockType.CoalOre,
  BlockType.IronOre,
  BlockType.GoldOre,
  BlockType.DiamondOre,
  BlockType.EmeraldOre,
  BlockType.LapisOre,
  BlockType.RedstoneOre,
  BlockType.CopperOre,
];
const PLACE_NAMES: Record<BlockType, string> = {
  [BlockType.Air]: "Air",
  [BlockType.Grass]: "Grass",
  [BlockType.Dirt]: "Dirt",
  [BlockType.Stone]: "Stone",
  [BlockType.CoalOre]: "Coal Ore",
  [BlockType.IronOre]: "Iron Ore",
  [BlockType.GoldOre]: "Gold Ore",
  [BlockType.DiamondOre]: "Diamond Ore",
  [BlockType.EmeraldOre]: "Emerald Ore",
  [BlockType.LapisOre]: "Lapis Ore",
  [BlockType.RedstoneOre]: "Redstone Ore",
  [BlockType.CopperOre]: "Copper Ore",
};

function updateHotbar(type: BlockType): void {
  const el = document.getElementById("hotbar");
  if (el)
    el.innerHTML = `Block: <strong>${PLACE_NAMES[type]}</strong>&nbsp;&nbsp;<kbd class="kbd kbd-sm">E</kbd>&nbsp;to cycle`;
}

/**
 * Manages keyboard + pointer-lock mouse input.
 * Computes a horizontal wish-direction each frame and delegates
 * movement + jumping to the Physics system.
 */
export class InputManager {
  private keys = new Set<string>();
  private camera: Camera;
  private physics: Physics;
  private world: World;
  private onBlockEdit: BlockEditCallback;
  private pointerLocked = false;
  private placeTypeIndex = 0;
  get placeBlockType(): BlockType {
    return PLACE_CYCLE[this.placeTypeIndex];
  }
  /**
   * After (re-)acquiring pointer lock, skip this many mousemove events.
   * Browsers queue up accumulated mouse deltas from while the window was
   * unfocused and flush them the moment the pointer is locked again, causing
   * a violent camera sweep.  Draining a few frames eliminates that burst.
   */
  private skipMouseEvents = 0;

  // Pre-allocated scratch vectors to avoid per-frame GC pressure.
  private wish = vec3.create();

  constructor(
    canvas: HTMLCanvasElement,
    camera: Camera,
    physics: Physics,
    world: World,
    onBlockEdit: BlockEditCallback,
  ) {
    this.camera = camera;
    this.physics = physics;
    this.world = world;
    this.onBlockEdit = onBlockEdit;
    // Initialise hotbar display.
    updateHotbar(this.placeBlockType);

    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
      // Cycle held block type with E.
      if (e.code === "KeyE" && this.pointerLocked) {
        this.placeTypeIndex = (this.placeTypeIndex + 1) % PLACE_CYCLE.length;
        updateHotbar(PLACE_CYCLE[this.placeTypeIndex]);
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    // Left-click: request pointer lock when not locked; break block when locked.
    // Right-click: place block when locked.
    canvas.addEventListener("mousedown", (e) => {
      if (!this.pointerLocked) {
        canvas.requestPointerLock();
        return;
      }
      const hit = raycast(
        this.camera.position,
        this.camera.getForward(),
        this.world,
      );
      if (!hit) return;
      if (e.button === 0) {
        // Break
        this.world.setBlock(hit.bx, hit.by, hit.bz, BlockType.Air);
        this.onBlockEdit(hit.bx, hit.by, hit.bz);
      } else if (e.button === 2) {
        // Place on the face normal
        const px = hit.bx + hit.nx;
        const py = hit.by + hit.ny;
        const pz = hit.bz + hit.nz;
        // Don't place inside the player.
        if (!this.world.setBlock(px, py, pz, this.placeBlockType)) return;
        this.onBlockEdit(px, py, pz);
      }
    });
    // Suppress right-click context menu.
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("click", () => {
      if (!this.pointerLocked) canvas.requestPointerLock();
    });

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
