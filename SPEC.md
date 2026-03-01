# Voxel Engine Specification

> Turn the existing WebGL triangle scaffold into a playable Minecraft-like voxel world.

## Guiding Principles

| Principle                    | Rationale                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| **Keep raw WebGL**           | The whole point of this project is learning – no Three.js / Babylon. |
| **Minimal new dependencies** | Only `gl-matrix` (already installed).                                |
| **Incremental steps**        | Every step produces something visible on screen.                     |

---

## Architecture Overview

```
main.ts                 Entry – get GL context, create Camera + World, start loop
├── canvas.ts           Unchanged – provides WebGLRenderingContext
├── camera.ts           NEW – FPS camera (position, rotation, view/projection matrices)
├── input.ts            NEW – Keyboard + Pointer-Lock mouse input
├── world/
│   ├── block.ts        NEW – Block type enum (Air, Grass, Dirt, Stone …)
│   ├── chunk.ts        NEW – 16³ voxel storage + mesh builder
│   └── world.ts        NEW – Manages a grid of chunks, exposes get/setBlock
├── renderer.ts         REWRITTEN – clears, sets camera uniforms, draws every chunk
├── renderer-utils.ts   Unchanged – shader compile/link helpers
├── shader-materials.ts Updated – add Voxel material
├── shaders/
│   └── voxel/          NEW – vertex + fragment shaders with MVP + per-face color
└── time-manager.ts     Unchanged
```

---

## Step 1 – Voxel Shader (`src/shaders/voxel/`)

### Why first?

Everything else (camera, chunks) needs a shader that accepts `u_viewMatrix` and `u_projectionMatrix`. Writing the shader first means we can test every subsequent step visually.

### Vertex Shader (`voxel_VERTEXSHADER.glsl`)

```glsl
attribute vec3 a_position;
attribute vec3 a_color;
varying vec3 v_color;

uniform mat4 u_modelMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;

void main() {
    v_color = a_color;
    gl_Position = u_projectionMatrix * u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
}
```

### Fragment Shader (`voxel_FRAGMENTSHADER.glsl`)

```glsl
precision mediump float;
varying vec3 v_color;

void main() {
    gl_FragColor = vec4(v_color, 1.0);
}
```

### Hook up

Register the new shader pair in `shader-materials.ts` as `Materials.Voxel`.

---

## Step 2 – FPS Camera (`src/camera.ts`)

A first-person camera needs three things:

| What                  | How                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| **Position** (`vec3`) | Moved with WASD + Space/Shift                                                                           |
| **Orientation**       | Yaw + Pitch angles updated by mouse delta                                                               |
| **Matrices**          | `mat4.lookAt(eye, eye+forward, up)` for view; `mat4.perspective(fov, aspect, near, far)` for projection |

### API

```ts
class Camera {
  position: vec3;
  yaw: number; // radians, around Y
  pitch: number; // radians, around X (clamped ±89°)

  getViewMatrix(): mat4;
  getProjectionMatrix(aspect: number): mat4;
  moveForward(d: number): void;
  moveRight(d: number): void;
  moveUp(d: number): void;
  rotate(dx: number, dy: number): void;
}
```

---

## Step 3 – Input Manager (`src/input.ts`)

- Track pressed keys in a `Set<string>`.
- On canvas click → `canvas.requestPointerLock()`.
- On `mousemove` during pointer-lock → feed dx/dy to `camera.rotate()`.
- Every frame, read the key set and call `camera.moveForward/Right/Up` scaled by `Time.deltaTime`.

---

## Step 4 – Block Types (`src/world/block.ts`)

```ts
export enum BlockType {
  Air = 0,
  Grass = 1,
  Dirt = 2,
  Stone = 3,
}
```

Each type maps to a face color (later, a texture atlas UV). For now a simple `Record<BlockType, [r,g,b]>` lookup is sufficient.

---

## Step 5 – Chunk Data & Mesh Builder (`src/world/chunk.ts`)

### Data

A chunk is 16 × 16 × 16 blocks stored as a flat `Uint8Array(4096)`.

```
index = x + z * 16 + y * 256
```

### Mesh builder – `buildMesh()`

For every non-Air block, check its 6 axis-aligned neighbors.
If the neighbor is Air (or outside the chunk), emit 2 triangles (1 quad) for that face.

Each vertex carries:

- `vec3 position` (block corner in chunk-local space)
- `vec3 color` (looked up from block type + face direction for shading)

Darken top/bottom/side faces slightly to fake directional lighting:

- Top face → base color × 1.0
- Side faces → base color × 0.8
- Bottom face → base color × 0.5

### GPU upload

`buildMesh()` returns `{ positions: Float32Array, colors: Float32Array, vertexCount: number }`.
Upload once into two `STATIC_DRAW` buffers. Re-build only when a block changes.

---

## Step 6 – World Manager (`src/world/world.ts`)

Manages a flat `Map<string, Chunk>` keyed by `"cx,cz"`.

### Bootstrap

On init, generate a small grid (e.g. 4×4 chunks). Fill each chunk with a simple heightmap:

```ts
for x,z in 0..15:
    height = 4 + floor(sin(worldX*0.1) * 2 + cos(worldZ*0.15) * 2)
    fill blocks 0..height-2 with Stone
    fill block  height-1    with Dirt
    fill block  height      with Grass
```

This gives gentle rolling hills out of the box.

---

## Step 7 – Rewrite Renderer (`src/renderer.ts`)

The render loop becomes:

```
EngineRenderer(gl):
    compile voxel shader program
    create Camera, InputManager, World
    world.generateTerrain()
    for each chunk → chunk.buildMesh() → upload buffers

    loop (requestAnimationFrame):
        Time.update()
        input.update(camera)
        gl.clear(COLOR | DEPTH)
        gl.useProgram(voxelProgram)
        set u_viewMatrix      ← camera.getViewMatrix()
        set u_projectionMatrix ← camera.getProjectionMatrix()
        for each chunk:
            set u_modelMatrix ← translate(chunkX*16, 0, chunkZ*16)
            bindBuffers(chunk)
            gl.drawArrays(TRIANGLES, 0, chunk.vertexCount)
```

---

## Step 8 – Full-screen Canvas & Clean UI

- Remove the decorative nav/title from `messages.ts` (or hide it).
- Make the canvas fill the window (`width: 100vw; height: 100vh`).
- Resize dynamically so the viewport always matches.
- Add a simple crosshair (CSS `::after` on a centered div).

---

## Future Steps (not implemented now)

| Feature                  | Notes                                                         |
| ------------------------ | ------------------------------------------------------------- |
| Texture atlas            | Replace per-face colors with UV sampling from a sprite-sheet. |
| Block breaking / placing | Raycast from camera into the chunk grid.                      |
| Greedy meshing           | Merge coplanar same-type faces to cut vertex count ~70 %.     |
| Frustum culling          | Skip `drawArrays` for chunks outside the camera frustum.      |
| Infinite terrain         | Generate new chunks on the fly as the player moves.           |
| Collision / gravity      | AABB sweep against the block grid.                            |
| Ambient occlusion        | Darken vertices that are tucked into corners.                 |
