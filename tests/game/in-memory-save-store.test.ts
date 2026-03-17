import { describe, expect, it } from "vitest";
import { InMemorySaveStore } from "../../src/logic/session/in-memory-save-store";
import { createGeneratedSave } from "../../src/logic/session/session-codec";

function makeSnapshot() {
  return createGeneratedSave("tmp", 2);
}

describe("InMemorySaveStore", () => {
  it("creates, lists, gets, updates, renames, and removes saves", () => {
    const store = new InMemorySaveStore();

    const created = store.create("World 1", makeSnapshot());
    expect(created.id).toMatch(/^save-\d+$/);
    expect(store.list()).toHaveLength(1);

    const loaded = store.get(created.id);
    expect(loaded?.name).toBe("World 1");

    const updated = store.update(
      created.id,
      makeSnapshot(),
    );
    expect(updated.id).toBe(created.id);
    expect(updated.createdAtMs).toBe(created.createdAtMs);
    expect(updated.updatedAtMs).toBeGreaterThanOrEqual(
      created.updatedAtMs,
    );

    store.rename(created.id, "Renamed");
    expect(store.get(created.id)?.name).toBe("Renamed");

    store.remove(created.id);
    expect(store.list()).toHaveLength(0);
    expect(store.get(created.id)).toBeNull();
  });

  it("returns deep copies", () => {
    const store = new InMemorySaveStore();
    const created = store.create("World 1", makeSnapshot());

    const loaded = store.get(created.id)!;
    loaded.world.chunks[0].blocks[0] = 255;

    const loadedAgain = store.get(created.id)!;
    expect(loadedAgain.world.chunks[0].blocks[0]).not.toBe(
      255,
    );
  });
});
