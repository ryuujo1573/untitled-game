import { describe, expect, it } from "vitest";
import { Camera } from "../../src/camera";
import {
  captureFromRuntime,
  createGeneratedSave,
  hydrateRuntime,
} from "../../src/game/session-codec";
import type { InputManager } from "../../src/input";
import { Physics } from "../../src/physics";
import Time from "../../src/time-manager";
import { BlockType } from "../../src/world/block";
import { World } from "../../src/world/world";

describe("session codec", () => {
  it("captures and hydrates player/time", () => {
    const world = new World();
    world.generate(2);

    const camera = new Camera();
    camera.setPose([5, 6, 7], 1.2, -0.4);

    const physics = new Physics(camera, world);
    physics.setState({
      velocity: [1, 2, 3],
      onGround: true,
    });

    let selected = BlockType.Stone;
    const input = {
      get placeBlockType() {
        return selected;
      },
      setSelectedBlockType(type: BlockType) {
        selected = type;
      },
    } as unknown as InputManager;

    Time.setWorldTime(0.66);

    const save = captureFromRuntime(
      { world, camera, physics, input },
      { id: "save-1", name: "World 1", createdAtMs: 123 },
    );

    expect(save.player.position).toEqual([5, 6, 7]);
    expect(save.player.velocity).toEqual([1, 2, 3]);
    expect(save.environment.worldTime).toBeCloseTo(0.66);

    const world2 = World.fromSnapshot(save.world);
    const camera2 = new Camera();
    const physics2 = new Physics(camera2, world2);
    let selected2 = BlockType.Dirt;
    const input2 = {
      get placeBlockType() {
        return selected2;
      },
      setSelectedBlockType(type: BlockType) {
        selected2 = type;
      },
    } as unknown as InputManager;

    hydrateRuntime(save, {
      world: world2,
      camera: camera2,
      physics: physics2,
      input: input2,
    });

    expect(camera2.getPose().position).toEqual([5, 6, 7]);
    expect(physics2.getState().velocity).toEqual([1, 2, 3]);
    expect(selected2).toBe(BlockType.Stone);
    expect(Time.getWorldTime()).toBeCloseTo(0.66);
  });

  it("creates placeholder-compatible generated saves", () => {
    const snapshot = createGeneratedSave("World 1");
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.meta).toEqual({});
    expect(snapshot.world.chunks.length).toBeGreaterThan(0);
  });
});
