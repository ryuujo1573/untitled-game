import type { InputManager } from "~/engine/input/input";
import type { Physics } from "~/engine/physics/physics";
import type { Camera } from "~/engine/rendering/camera";

import Time from "~/environment/time/time-manager";
import { BlockType } from "~/environment/world/block";
import { World } from "~/environment/world/world";

import type { GameSaveV1 } from "~/logic/session/session-types";

interface RuntimeRefs {
  world: World;
  camera: Camera;
  physics: Physics;
  input: InputManager;
}

interface SaveMeta {
  id: string;
  name: string;
  createdAtMs: number;
}

export function createGeneratedSave(
  _name: string,
  gridSize = 4,
): Omit<GameSaveV1, "id" | "name" | "createdAtMs" | "updatedAtMs"> {
  const world = new World();
  world.generate(gridSize);

  return {
    version: 1,
    world: world.toSnapshot(),
    player: {
      position: [32, 20, 32],
      yaw: 0,
      pitch: -0.3,
      velocity: [0, 0, 0],
      onGround: false,
      selectedBlockType: BlockType.Dirt,
    },
    environment: {
      worldTime: 0.25,
    },
    entities: [],
    meta: {},
  };
}

export function captureFromRuntime(
  runtime: RuntimeRefs,
  meta: SaveMeta,
): GameSaveV1 {
  const pose = runtime.camera.getPose();
  const physics = runtime.physics.getState();

  return {
    version: 1,
    id: meta.id,
    name: meta.name,
    createdAtMs: meta.createdAtMs,
    updatedAtMs: Date.now(),
    world: runtime.world.toSnapshot(),
    player: {
      position: pose.position,
      yaw: pose.yaw,
      pitch: pose.pitch,
      velocity: physics.velocity,
      onGround: physics.onGround,
      selectedBlockType: runtime.input.placeBlockType,
    },
    environment: {
      worldTime: Time.getWorldTime(),
    },
    entities: [],
    meta: {},
  };
}

export function hydrateRuntime(save: GameSaveV1, runtime: RuntimeRefs): void {
  runtime.camera.setPose(
    save.player.position,
    save.player.yaw,
    save.player.pitch,
  );
  runtime.physics.setState({
    velocity: save.player.velocity,
    onGround: save.player.onGround,
  });
  runtime.input.setSelectedBlockType(
    save.player.selectedBlockType as BlockType,
  );
  Time.setWorldTime(save.environment.worldTime);
}
