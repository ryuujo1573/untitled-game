import type { GameSaveV1, SaveSummary } from "~/game/session-types";

function deepCloneSave(save: GameSaveV1): GameSaveV1 {
  return {
    ...save,
    world: {
      ...save.world,
      generator: { ...save.world.generator },
      chunks: save.world.chunks.map((chunk) => ({
        cx: chunk.cx,
        cz: chunk.cz,
        blocks: new Uint8Array(chunk.blocks),
      })),
    },
    player: {
      ...save.player,
      position: [...save.player.position] as [number, number, number],
      velocity: [...save.player.velocity] as [number, number, number],
    },
    environment: { ...save.environment },
    entities: save.entities.map((entity) => ({
      ...entity,
      data: { ...entity.data },
    })),
    meta: { ...save.meta },
  };
}

function nowMs(): number {
  return Date.now();
}

export class InMemorySaveStore {
  private readonly saves = new Map<string, GameSaveV1>();
  private nextId = 1;

  list(): SaveSummary[] {
    return Array.from(this.saves.values())
      .map((save) => ({
        id: save.id,
        name: save.name,
        createdAtMs: save.createdAtMs,
        updatedAtMs: save.updatedAtMs,
      }))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  get(id: string): GameSaveV1 | null {
    const save = this.saves.get(id);
    return save ? deepCloneSave(save) : null;
  }

  create(name: string, snapshot: Omit<GameSaveV1, "id" | "name" | "createdAtMs" | "updatedAtMs">): GameSaveV1 {
    const timestamp = nowMs();
    const id = `save-${this.nextId++}`;
    const save: GameSaveV1 = {
      ...deepCloneSave({
        ...snapshot,
        id,
        name,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      }),
      id,
      name,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    };
    this.saves.set(id, save);
    return deepCloneSave(save);
  }

  update(id: string, snapshot: Omit<GameSaveV1, "id" | "name" | "createdAtMs" | "updatedAtMs">): GameSaveV1 {
    const existing = this.saves.get(id);
    if (!existing) {
      throw new Error(`Save not found: ${id}`);
    }

    const updatedAtMs = nowMs();
    const next: GameSaveV1 = {
      ...deepCloneSave({
        ...snapshot,
        id,
        name: existing.name,
        createdAtMs: existing.createdAtMs,
        updatedAtMs,
      }),
      id,
      name: existing.name,
      createdAtMs: existing.createdAtMs,
      updatedAtMs,
    };

    this.saves.set(id, next);
    return deepCloneSave(next);
  }

  rename(id: string, name: string): void {
    const save = this.saves.get(id);
    if (!save) {
      throw new Error(`Save not found: ${id}`);
    }
    save.name = name;
    save.updatedAtMs = nowMs();
  }

  remove(id: string): void {
    this.saves.delete(id);
  }
}
