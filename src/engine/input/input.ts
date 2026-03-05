import { vec3 } from "gl-matrix";
import type { Camera } from "~/engine/rendering/camera";
import type { Physics } from "~/engine/physics/physics";
import type { World } from "~/environment/world/world";
import { BlockType } from "~/environment/world/block";
import { raycast } from "~/engine/physics/raycaster";
import type { PauseMenu } from "~/ui/pause-menu";
import type { ChatBox } from "~/ui/chat-box";
import { type InputBackend, isTauriRuntime } from "./input-backend";
import { NativeInputManager } from "./native-input";
import { WebInputManager } from "./web-input";

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
  private chatBox!: ChatBox;
  private placeTypeIndex = 0;
  private inputBackend: InputBackend;
  private readonly disposers: Array<() => void> = [];

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
    chatBox: ChatBox,
  ) {
    this.camera = camera;
    this.physics = physics;
    this.world = world;
    this.onBlockEdit = onBlockEdit;
    this.pauseMenu = pauseMenu;
    this.chatBox = chatBox;
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
    const onBeforeUnload = () => {
      this.inputBackend.destroy?.();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    this.disposers.push(() =>
      window.removeEventListener("beforeunload", onBeforeUnload),
    );

    const onKeyDown = (e: KeyboardEvent) => {
      // If chat is open, ignore game inputs
      if (this.chatBox.openStatus) return;

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

      // Enter: open chat
      if (e.code === "Enter") {
        e.preventDefault();
        this.chatBox.open();
        this.inputBackend.unlock();
        return;
      }

      // Slash: open chat with /
      if (e.code === "Slash") {
        e.preventDefault();
        this.chatBox.open("/");
        this.inputBackend.unlock();
        return;
      }

      // Cycle held block type with E.
      if (e.code === "KeyE" && this.inputBackend.isLocked()) {
        this.placeTypeIndex = (this.placeTypeIndex + 1) % PLACE_CYCLE.length;
        updateHotbar(PLACE_CYCLE[this.placeTypeIndex]);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    this.disposers.push(() => window.removeEventListener("keydown", onKeyDown));
    this.disposers.push(() => window.removeEventListener("keyup", onKeyUp));

    // Left-click: request pointer lock when not locked; break block when locked.
    // Right-click: place block when locked.
    const onMouseDown = (e: MouseEvent) => {
      if (this.chatBox.openStatus) return;

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
    };
    canvas.addEventListener("mousedown", onMouseDown);
    this.disposers.push(() =>
      canvas.removeEventListener("mousedown", onMouseDown),
    );
    // Suppress right-click context menu.
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    canvas.addEventListener("contextmenu", onContextMenu);
    this.disposers.push(() =>
      canvas.removeEventListener("contextmenu", onContextMenu),
    );

    const onClick = () => {
      if (this.chatBox.openStatus) return;
      if (!this.inputBackend.isLocked()) this.inputBackend.requestLock();
    };
    canvas.addEventListener("click", onClick);
    this.disposers.push(() => canvas.removeEventListener("click", onClick));

    // Handle standard pointer lock escape for pause menu
    const onPointerLockChange = () => {
      if (
        !document.pointerLockElement &&
        !this.pauseMenu.paused &&
        !this.chatBox.openStatus &&
        !this.nativeMode
      ) {
        this.keys.clear();
        this.pauseMenu.pause();
      }
    };
    document.addEventListener("pointerlockchange", onPointerLockChange);
    this.disposers.push(() =>
      document.removeEventListener("pointerlockchange", onPointerLockChange),
    );

    const onBlur = () => {
      this.keys.clear();
      if (this.inputBackend.isLocked()) {
        this.inputBackend.unlock();
      }
      if (!this.pauseMenu.paused && !this.chatBox.openStatus) {
        this.pauseMenu.pause();
      }
    };
    window.addEventListener("blur", onBlur);
    this.disposers.push(() => window.removeEventListener("blur", onBlur));
  }

  /** Call this (e.g. from the pause menu resume callback) to re-acquire the cursor. */
  requestLock(): void {
    this.inputBackend.requestLock();
  }

  /** Call once per frame – feeds wish direction and jump into Physics. */
  update(): void {
    if (this.pauseMenu.paused || this.chatBox.openStatus) return;

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
            this.camera.rotate(
              rx * lookScale * this.sensitivityMultiplier,
              ry * lookScale * this.sensitivityMultiplier,
            );
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

  setSelectedBlockType(type: BlockType): void {
    const index = PLACE_CYCLE.indexOf(type);
    if (index === -1) return;
    this.placeTypeIndex = index;
    updateHotbar(type);
  }

  destroy(): void {
    this.disposers.forEach((dispose) => {
      dispose();
    });
    this.disposers.length = 0;
    this.inputBackend.unlock();
    this.inputBackend.destroy?.();
  }
}
