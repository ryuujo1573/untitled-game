import "vite/client";
import "@webgpu/types";

// Tauri internals
declare global {
  interface Window {
    __TAURI_INTERNALS__: unknown;
    __TAURI__: unknown;
  }
  // const __TAURI_INTERNALS__: unknown;
  // const __TAURI__: unknown;

  declare interface ImportMeta {
    readonly isTauri: boolean;
  }
}

// Allow importing .wgsl files as raw strings via Vite's ?raw suffix.
declare module "*.wgsl?raw" {
  const source: string;
  export default source;
}
