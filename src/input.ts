import { vec3 } from "gl-matrix";
import { Camera } from "./camera";
import { Physics } from "./physics";
import { World } from "./world/world";
import { BlockType } from "./world/block";
import { raycast } from "./raycaster";
import { PauseMenu } from "./pause-menu";
import { InputBackend, isTauriRuntime } from "./input-backend";
import { WebInputManager } from "./web-input";
import { NativeInputManager } from "./native-input";

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
  private nativeMode = false;
  private sensitivityMultiplier = 1.0;
  private pauseMenu!: PauseMenu;
  private placeTypeIndex = 0;
  private inputBackend: InputBackend;

  get placeBlockType(): BlockType {
    return PLACE_CYCLE[this.placeTypeIndex];
  }

  // Pre-allocated scratch vectors to avoid per-frame GC pressure.
  private wish = vec3.create();

  constructor(
    canvas: HTMLCanvasElement,
    camera: Camera,
    physics: Physics,
    world: World,
    onBlockEdit: BlockEditCallback,
    pauseMenu: PauseMenu,
  ) {
    this.camera = camera;
    this.physics = physics;
    this.world = world;
    this.onBlockEdit = onBlockEdit;
    this.pauseMenu = pauseMenu;
    // Initialise hotbar display.
    updateHotbar(this.placeBlockType);

    // Choose backend
    if (isTauriRuntime()) {
      this.nativeMode = true;
      this.inputBackend = new NativeInputManager(canvas);
      this.sensitivityMultiplier = 1.0;
    } else {
      this.inputBackend = new WebInputManager(canvas);
      this.sensitivityMultiplier = 1.0;
    }

    // Cancel backend event subscriptions on page unload (HMR reloads, app close).
    window.addEventListener("beforeunload", () => {
      this.inputBackend.destroy?.();
    });

    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
      // ESC: handle pause
      if (e.code === "Escape") {
        e.preventDefault();
        if (this.inputBackend.isLocked()) {
          this.inputBackend.unlock();
          this.pauseMenu.pause();
        } else {
          this.pauseMenu.toggle();
        }
        return;
      }
      // Cycle held block type with E.
      if (e.code === "KeyE" && this.inputBackend.isLocked()) {
        this.placeTypeIndex = (this.placeTypeIndex + 1) % PLACE_CYCLE.length;
        updateHotbar(PLACE_CYCLE[this.placeTypeIndex]);
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    // Left-click: request pointer lock when not locked; break block when locked.
    // Right-click: place block when locked.
    canvas.addEventListener("mousedown", (e) => {
      if (!this.inputBackend.isLocked()) {
        this.inputBackend.requestLock();
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
      if (!this.inputBackend.isLocked()) this.inputBackend.requestLock();
    });

    // Handle standard pointer lock escape for pause menu
    document.addEventListener("pointerlockchange", () => {
        if (!document.pointerLockElement && !this.pauseMenu.paused && !this.nativeMode) {
            this.keys.clear();
            this.pauseMenu.pause();
        }
    });

    window.addEventListener("blur", () => {
      this.keys.clear();
      if (this.inputBackend.isLocked()) {
        this.inputBackend.unlock();
      }
    });
  }

  /** Call this (e.g. from the pause menu resume callback) to re-acquire the cursor. */
  requestLock(): void {
    this.inputBackend.requestLock();
  }

  /** Call once per frame – feeds wish direction and jump into Physics. */
  update(): void {
    if (this.pauseMenu.paused) return;

    // Use backend to update camera rotation
    this.inputBackend.update(this.camera, this.sensitivityMultiplier);

    const fwd = this.camera.getFlatForward();
    const right = this.camera.getRight();

    // Build wish direction from held keys.
    vec3.set(this.wish, 0, 0, 0);
    if (this.keys.has("KeyW")) vec3.scaleAndAdd(this.wish, this.wish, fwd, 1);
    if (this.keys.has("KeyS")) vec3.scaleAndAdd(this.wish, this.wish, fwd, -1);
    if (this.keys.has("KeyD")) vec3.scaleAndAdd(this.wish, this.wish, right, 1);
    if (this.keys.has("KeyA"))
      vec3.scaleAndAdd(this.wish, this.wish, right, -1);

    // Basic gamepad support: left stick for movement, right stick for look.
    try {
      const pads = navigator.getGamepads && navigator.getGamepads();
      if (pads && pads.length) {
        for (const p of pads) {
          if (!p) continue;
          const lx = p.axes[0] ?? 0;
          const ly = p.axes[1] ?? 0;
          const rx = p.axes[2] ?? 0;
          const ry = p.axes[3] ?? 0;
          // Deadzone
          const dead = 0.15;
          const apply = (v: number) => (Math.abs(v) > dead ? v : 0);
          const ax = apply(lx);
          const ay = apply(ly);
          if (ax !== 0 || ay !== 0) {
            vec3.scaleAndAdd(this.wish, this.wish, right, ax);
            vec3.scaleAndAdd(this.wish, this.wish, fwd, -ay);
          }
          if (rx !== 0 || ry !== 0) {
            const lookScale = 6.0; // tune how quickly gamepad looks
            this.camera.rotate(rx * lookScale * this.sensitivityMultiplier, ry * lookScale * this.sensitivityMultiplier);
          }
        }
      }
    } catch {}

    // Normalise diagonal movement so it isn't faster than cardinal.
    if (vec3.length(this.wish) > 0) vec3.normalize(this.wish, this.wish);

    // Jump request is handled inside Physics (only fires when onGround).
    if (this.keys.has("Space")) this.physics.jump();

    this.physics.update(this.wish[0], this.wish[2]);
  }
}
