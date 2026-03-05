# Voxxer

Experimental Minecraft-like voxel renderer/sandbox written in TypeScript.

- Primary renderer: WebGPU (deferred pipeline), with WebGL2 fallback
- Runs in the browser (Vite) and as a desktop app (Tauri 2)
- Shaderpacks: load + parse Iris/OptiFine-style packs (not executed yet)

## Status

This repo started as a WebGL triangle scaffold and has evolved into a voxel engine prototype. It is active WIP and not feature-complete.

Current notable limitations:

- Shaderpacks are loaded for property parsing only; GLSL stages are not compiled/executed yet
- Saves are in-memory only (no persistence)

## Quick Start (Web)

Prerequisites: Bun.

```bash
bun install
bun run dev
```

Vite runs on http://localhost:2556.

Other useful commands:

```bash
bun run build
bun run preview
```

## Desktop App (Tauri 2)

Prerequisites:

- https://v2.tauri.app/start/prerequisites/

Run:

```bash
bun install
bun run tauri:dev
```

Build:

```bash
bun run tauri:build
```

## Controls

- Click the canvas to lock mouse (pointer lock)
- WASD move, Space jump
- LMB break block, RMB place block
- E cycle held block type
- Esc pause/unlock
- Enter or / open chat
- F3 toggle debug overlay (F3+L toggles light debug overlay)

## Shaderpacks (Current Support)

Shaderpacks can be added/selected from the in-game pause menu:

- Press Esc → Shaderpacks → add a folder or a .zip
- On web builds this uses the browser file picker; on Tauri it uses native dialogs and can access the filesystem

Today, packs are used to parse and store metadata (for example `shaders.properties` and block mappings). Rendering stages show as builtin because GLSL→WGSL compilation is currently unavailable.

See [SHADER.md](./SHADER.md) for the target compatibility contract.

## PBR / Texture Overrides (Dev Hook)

There is a small runtime integration point for swapping the block atlas and a few environment textures at runtime:

```js
window.__PBR_PACK_BASE_URL = "/packs/my-pack/textures/block";
window.__CLOUD_TEXTURE_URL = "/packs/my-pack/environment/clouds.png";
window.__SKYBOX_TEXTURE_URL = "/packs/my-pack/environment/skybox.png";
```

Alternatively, provide `window.__PBR_TEXTURE_MANIFEST__` with explicit per-tile URLs (see [resource-pack.ts](./src/environment/resource/resource-pack.ts)).

## Tech Stack

- TypeScript, Vite, Bun
- SolidJS UI + Tailwind CSS
- WebGPU (primary) + WebGL2 (fallback)
- Tauri 2 desktop wrapper

## Project Layout

```
src/
  engine/        Rendering backends, shaderpack + VFS, input, physics
  environment/   World, blocks, lighting, time, resource-pack integration
  logic/         Session orchestration + settings
  ui/            SolidJS overlays (title/pause/chat/debug)
  main.ts        App entrypoint
src-tauri/       Tauri host app + config
tests/           Vitest suites (world, shaderpack parsing, session logic)
```

## Development

```bash
bun run build
bun run test
bun run test:watch
```

The test suite exists but currently fails due to outdated import paths after refactors.

Generate the small built-in block texture set:

```bash
bun scripts/gen-base-textures.ts
```

## Roadmap / Notes

- [SPEC.md](./SPEC.md) contains the original incremental spec from the early voxel/WebGL phase
- [SHADER.md](./SHADER.md) documents the intended shaderpack + labPBR compatibility surface
