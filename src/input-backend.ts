import type { Camera } from "./camera";

/**
 * Interface for input backends (Web vs Native).
 */
export interface InputBackend {
  update(
    camera: Camera,
    sensitivityMultiplier: number,
  ): void;
  requestLock(): void;
  unlock(): void;
  isLocked(): boolean;
  destroy?(): void;
}

/**
 * Common utilities for input management.
 */
export function isTauriRuntime(): boolean {
  const im = import.meta as any;
  if (typeof im.isTauri === "boolean") return im.isTauri;
  return (
    typeof (window as any).__TAURI_INTERNALS__ !==
      "undefined" ||
    typeof (window as any).__TAURI__ !== "undefined"
  );
}
