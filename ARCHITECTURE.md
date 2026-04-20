# Architecture

> Top-level map of crates, layers, and dependency directions.
> See [AGENTS.md](AGENTS.md) for navigation, or drill into `docs/` for details.

## Crate Graph

```
┌───────────────────────────────────────────────────────────┐
│                   game/  (binary: voidborne)                 │
│  app.rs  winit loop, input, physics, session save/load    │
└──────────┬────────────────────────────────────────────────┘
           │ uses
┌──────────▼────────────────────────────────────────────────┐
│              crates/voidborne-render                         │
│  GpuContext · TexturePool · RenderGraph                   │
│  GbufferPass · ShadowPass · LightingPass · PostPass       │
└──────────┬────────────────────────────────────────────────┘
           │ uses
┌──────────▼────────────────────────────────────────────────┐
│              crates/voidborne-world                          │
│  BlockState · Section (paletted) · ChunkColumn            │
│  BFS lighting · greedy SectionMesh · World · Worldgen     │
└──────────┬────────────────────────────────────────────────┘
           │ uses
  ┌────────┴──────────┬───────────────────┐
  ▼                   ▼                   ▼
voidborne-registry   voidborne-math         voidborne-util
Registry<T>       BlockPos/ChunkPos   Ident · Interner
RawId · TagMap    Aabb · oct-pack     log setup
                  SectionPos
           │
           ▼
       voidborne-ecs
  bevy_ecs re-export
  PreGame/Game/PostGame/Render schedule labels
```

## Dependency Rules

```
game → voidborne-render → voidborne-world → voidborne-{registry,math,util,ecs}
```

- **game** may import any crate.
- **voidborne-render** may import voidborne-world and below. Must NOT import game.
- **voidborne-world** may import voidborne-{registry,math,util,ecs}. Must NOT import render or game.
- **voidborne-{registry,math,util,ecs}** are leaf crates — no intra-workspace deps (except ecs → bevy_ecs extern).

## Crate Map

### `crates/voidborne-math`

| Module  | Responsibility                             | Key types                                        |
| ------- | ------------------------------------------ | ------------------------------------------------ |
| `coord` | World / chunk / section coordinate newtype | `BlockPos`, `ChunkPos`, `SectionPos`, `LocalPos` |
| `aabb`  | Axis-aligned bounding box + sweep test     | `Aabb`                                           |
| `pack`  | SNorm16 + oct-pack normal encoding         | `oct_encode`, `snorm16`                          |

### `crates/voidborne-util`

| Module   | Responsibility                    | Key types         |
| -------- | --------------------------------- | ----------------- |
| `ident`  | Namespaced identifier (`ns:path`) | `Ident`           |
| `intern` | String interning                  | `Interner`, `Sym` |
| `log`    | `tracing` subscriber setup        | `init_logging()`  |

### `crates/voidborne-registry`

| Item          | Responsibility                            |
| ------------- | ----------------------------------------- |
| `Registry<T>` | Frozen ordered registry with RawId lookup |
| `TagMap`      | Multi-value tag → `Vec<RawId>` index      |

### `crates/voidborne-ecs`

Re-exports `bevy_ecs` and defines named schedule labels:
`PreGameSchedule`, `GameSchedule`, `PostGameSchedule`, `RenderSchedule`.

### `crates/voidborne-world`

| Module     | Responsibility                         | Key types                          |
| ---------- | -------------------------------------- | ---------------------------------- |
| `block`    | Block state definitions, registry init | `BlockState`, `BLOCK_REGISTRY`     |
| `section`  | 16³ paletted voxel section             | `Section`                          |
| `column`   | Vertical stack of sections + heightmap | `ChunkColumn`                      |
| `mesh`     | Greedy meshing → `SectionMesh`         | `SectionMesh`, `QuadVertex`        |
| `light`    | BFS sky + block light propagation      | `propagate_sky`, `propagate_block` |
| `world`    | Loaded column map, chunk load/unload   | `World`                            |
| `worldgen` | Default terrain generator              | `DefaultWorldgen`                  |

### `crates/voidborne-render`

| Module            | Responsibility                                      | Key types               |
| ----------------- | --------------------------------------------------- | ----------------------- |
| `context`         | wgpu device / queue / surface init (winit)          | `GpuContext`            |
| `texture_pool`    | Screen-space render targets (G-buffer, shadow, HDR) | `TexturePool`           |
| `frame_data`      | Per-frame camera + sun UBO (CPU side)               | `FrameData`, `FrameUBO` |
| `mesh`            | GPU mesh upload + per-chunk UBO                     | `GpuMesh`               |
| `graph`           | Command encoder coordination                        | `RenderGraph`           |
| `passes/gbuffer`  | Opaque geometry → RT0-RT3 + depth                   | `GbufferPass`           |
| `passes/shadow`   | Depth-only CSM cascades                             | `ShadowPass`            |
| `passes/lighting` | Deferred resolve → HDR                              | `LightingPass`          |
| `passes/post`     | Bloom + TAA + ACES tonemap → surface                | `PostPass`              |
| `renderer`        | Top-level orchestrator                              | `VoidborneRenderer`        |

### `game/` — binary crate (`voidborne`)

| Module      | Responsibility                                       |
| ----------- | ---------------------------------------------------- |
| `main.rs`   | winit `EventLoop` entry point                        |
| `app.rs`    | Per-frame logic: input, physics, session save/load   |
| `engine/`   | Camera, AABB physics, raycaster                      |
| `renderer/` | Render thread + IPC (pre-rewrite compatibility shim) |
| `session/`  | Save/load codec, world snapshot                      |
| `world/`    | Block types, old world implementation (migration)    |
| `shaders/`  | Built-in WGSL sources                                |

## Runtime Flow

```
main.rs  →  winit EventLoop
              └─ App::new()
                   ├─ GpuContext::new(window)      wgpu surface init
                   ├─ World::new()                 chunk storage
                   ├─ DefaultWorldgen::generate()  terrain
                   └─ event loop
                        ├─ WindowEvent::KeyboardInput  → app.input()
                        ├─ WindowEvent::RedrawRequested
                        │    ├─ Physics::update(dt)    AABB sweep
                        │    ├─ World::update()        chunk gen/remesh
                        │    └─ VoidborneRenderer::draw()
                        │         ├─ ShadowPass   (CSM depth)
                        │         ├─ GbufferPass  (opaque terrain)
                        │         ├─ LightingPass (deferred resolve)
                        │         └─ PostPass     (tonemap → surface)
                        └─ WindowEvent::CloseRequested → session save
```

## GPU Pipeline (wgpu / WGSL)

```
GbufferPass   →  RT0 (albedo)
               →  RT1 (normals, oct-packed)
               →  RT2 (roughness / metallic)
               →  RT3 (emissive)
               →  depth (32-bit)

ShadowPass    →  shadow_map[4]  (CSM cascades, 2048×2048 each)

LightingPass  →  hdr_target  (deferred sun + ambient)

PostPass      →  surface  (ACES tonemap, optional bloom/TAA)
```

## Platform

Native desktop only — wgpu selects Vulkan / Metal / DX12 at runtime.
No browser, no Tauri shell, no WebGPU.
