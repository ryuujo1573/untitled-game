import type { Camera } from "~/engine/rendering/camera";

/**
 * Interface for input backends (Web vs Native).
 */
export interface InputBackend {
  update(camera: Camera, sensitivityMultiplier: number): void;
  requestLock(): void;
  unlock(): void;
  isLocked(): boolean;
  destroy?(): void;
}

/**
 * Common utilities for input management.
 */
export function isTauriRuntime(): boolean {
  const isTauri = import.meta.isTauri;
  if (typeof isTauri === "boolean") return isTauri;
  return (
    typeof window.__TAURI_INTERNALS__ !== "undefined" ||
    typeof window.__TAURI__ !== "undefined"
  );
}
