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

### Known bug fix — alt+tab camera sweep

**Symptoms:** After switching to another app with Alt+Tab and returning, the camera sweeps uncontrollably and movement keys get stuck.

**Root causes (two separate issues):**

1. **Stuck keys.** When the window loses focus the browser never fires `keyup` for keys held at the time of the switch. Those keys stay in the `keys` Set and keep driving movement after focus returns.

2. **Mouse delta burst.** When pointer lock is re-acquired (click after returning), some browsers flush accumulated `mousemove` events from the unfocused period all at once. These events fire _after_ `pointerlockchange` sets `pointerLocked = true`, so every queued delta is processed in rapid succession and rotates the camera wildly.

**Fixes applied in `InputManager`:**

```
window blur          → keys.clear()
                       Prevents phantom key-holds while the window is out of focus.

pointerlockchange
  lost lock          → keys.clear()  (safety net, covers Esc as well)
  gained lock        → skipMouseEvents = 5
                       Discards the next 5 mousemove events to drain the OS queue.

mousemove handler    → if (skipMouseEvents > 0) { skipMouseEvents--; return; }
```

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

## Step 9 – Collision & Gravity (`src/physics.ts`)

### Player AABB

The player is modelled as a box: **0.6 × 1.8 × 0.6** units (half-width 0.3 each side).
The camera sits at **eye height = 1.6** above the feet position.

### Algorithm – per-axis sweep

Each frame, collision is resolved axis-by-axis to prevent corner-clipping:

```
1. Apply gravity to velocity.y  (always, so the player probes the ground each frame)
2. Snap velocity.x / velocity.z  to wish direction × walk speed
3. For each axis (X then Y then Z):
     feet += velocity[axis] * dt
     if AABB overlaps any solid block → undo movement, zero that velocity component
     if axis=Y and we just hit going downward → onGround = true
4. camera.position = feet + (0, eyeHeight, 0)
```

Key values:

| Constant       | Value   | Purpose                            |
| -------------- | ------- | ---------------------------------- |
| `GRAVITY`      | −28 /s² | Pulls the player down each frame   |
| `JUMP_SPEED`   | 9 /s    | Upward velocity applied on jump    |
| `WALK_SPEED`   | 5 /s    | Horizontal speed from WASD         |
| `TERMINAL_VEL` | −50 /s  | Caps downward speed                |
| `dt` cap       | 0.05 s  | Prevents tunneling after tab pause |

### Controls (updated)

- **Space** — Jump (only when `onGround` is true)
- **WASD** — Walk (horizontal-only; pitch does not affect ground movement)
- Mouse — Look

---

## Step 10 – Block Raycasting (`src/raycaster.ts`)

### Algorithm – DDA (Digital Differential Analyzer)

The ray traversal steps through the voxel grid one cell at a time, always advancing
along the axis whose boundary is nearest:

```
1. For each axis compute:
     tDelta[axis] = |1 / direction[axis]|        // world-units between successive crossings
     tMax[axis]   = distance to first crossing    // from origin to the nearest grid line
     step[axis]   = +1 or -1                      // which direction to walk

2. Loop (up to maxDist / min(|dir|) iterations):
     choose axis with smallest tMax value
     cross that boundary  →  bx/by/bz += step[axis]
     faceNormal = -step[axis] on that axis (direction we came from)
     tMax[axis] += tDelta[axis]
     if world.getBlock(bx,by,bz) is solid → return RayHit

3. If no hit within maxDist units → return null
```

`RayHit` interface:

```typescript
interface RayHit {
  bx: number;
  by: number;
  bz: number; // hit block grid coordinates
  nx: number;
  ny: number;
  nz: number; // face normal (+1 or -1 on one axis)
}
```

### Break & Place

| Action | Input | Effect                                                                                            |
| ------ | ----- | ------------------------------------------------------------------------------------------------- |
| Break  | LMB   | `world.setBlock(hit.bx, hit.by, hit.bz, Air)` → `rebuildChunk()`                                  |
| Place  | RMB   | `world.setBlock(hit.bx + hit.nx, hit.by + hit.ny, hit.bz + hit.nz, placeType)` → `rebuildChunk()` |

The place position is the block adjacent to the hit face (`hit position + face normal`).
Right-click context menu is suppressed via `contextmenu` event handler.

### Chunk Rebuild

`rebuildChunk(gl, world, chunkX, chunkY, chunkZ)` in `renderer.ts`:

```
1. Delete old GPU buffers (position + color) stored in the chunkBuffers map
2. Call uploadChunk(gl, chunk) to re-generate the mesh and upload fresh buffers
```

Only the **one affected chunk** is rebuilt — neighbouring chunks are untouched unless
the edited block sits on a chunk boundary (future improvement).

### Block Cycling

- **E key** — cycles `placeTypeIndex` through `PLACE_CYCLE = [Dirt, Grass, Stone]`
- The hotbar DOM element updates immediately: `"Block: Grass  [E] to cycle"`

### Controls (updated)

| Key / Button | Action                                |
| ------------ | ------------------------------------- |
| LMB          | Break the targeted block              |
| RMB          | Place selected block on targeted face |
| E            | Cycle selected block type             |
| Space        | Jump                                  |
| WASD         | Walk                                  |
| Mouse        | Look                                  |

---

---

## Step 11 – Texture Atlas (`src/renderer.ts` + shaders)

### Atlas layout

A **64 × 16** pixel texture is generated at runtime using Canvas 2D (no external PNG).
It contains 4 tiles of 16 × 16 px each, laid out horizontally:

| Tile index | Content      | Used by                              |
| ---------- | ------------ | ------------------------------------ |
| 0          | `grass_top`  | Grass block +Y face                  |
| 1          | `grass_side` | Grass block side faces (+X/−X/+Z/−Z) |
| 2          | `dirt`       | Grass block −Y face + all Dirt faces |
| 3          | `stone`      | All Stone faces                      |

`BlockFaceTile` in `block.ts` maps each `BlockType` to a 6-element tuple
`[+Y, -Y, +X, -X, +Z, -Z]` of tile indices.

### Procedural pixel art

`createAtlasTexture(gl)` in `renderer.ts` uses a deterministic hash to add
per-pixel noise variation so tiles look like pixel art without any external asset:

```
hash(x, y, seed) → [0,1]
  n < 0.2  → dark shade
  n > 0.8  → light shade
  else     → base colour
```

The grass-side tile draws the dirt body first, then overrides the top 3 rows with
green pixels to simulate Minecraft's grass-side face.

`UNPACK_FLIP_Y_WEBGL = true` is set before `texImage2D` so canvas row 0 (top)
maps to UV `v = 1.0` (top of world face) instead of the default `v = 0.0`.

### Canonical face UVs

All 6 face types share the same 6-vertex UV pattern (unit quad, CCW winding):

```
CANONICAL_UVS = [0,0,  0,1,  1,1,  0,0,  1,1,  1,0]
```

Atlas UV for each vertex:

```
atlasU = tileIndex / ATLAS_TILES + localU * (1 / ATLAS_TILES)
atlasV = localV
```

### Shader changes

| Old (`v_color` path)     | New (`a_uvl` path)                          |
| ------------------------ | ------------------------------------------- |
| `attribute vec3 a_color` | `attribute vec3 a_uvl` (xy = UV, z = light) |
| `varying vec3 v_color`   | `varying vec2 v_uv; varying float v_light`  |
| `gl_FragColor = v_color` | `texture2D(u_atlas, v_uv).rgb * v_light`    |

The light multiplier from `FaceDef.light` (top=1.0, sides=0.7–0.8, bottom=0.5)
is packed as the `z` component of `a_uvl`, replacing the old per-component colour
darkening.

---

## Step 12 – Texture UV Fix + F3 Debug Overlay (`src/debug.ts`)

### UV rotation fix

The single `CANONICAL_UVS` pattern was correct for faces whose first planar axis
naturally maps to U, but produced a **90 ° rotation** on faces where the vertex
ordering has the vertical axis varying first.

Two named patterns now live in `chunk.ts`:

| Pattern | Values (12 floats, 6 vertices) | Faces                                   |
| ------- | ------------------------------ | --------------------------------------- |
| `UV_A`  | `0,0, 0,1, 1,1, 0,0, 1,1, 1,0` | +Y (U=X V=Z), +X (U=Z V=Y), −X (mirror) |
| `UV_B`  | `0,0, 1,0, 1,1, 0,0, 1,1, 0,1` | −Y (U=X V=Z), +Z (U=X V=Y), −Z (mirror) |

`FaceDef` has a new `uvs: number[]` field; `buildMesh()` uses `face.uvs[v*2]` /
`face.uvs[v*2+1]` instead of the old global constant.

### F3 Debug Overlay

Press **F3** to toggle a HUD panel (`#debug-panel`) that appears in the top-left
corner. It is invisible by default and adds zero per-frame cost when hidden.

#### Text panel (`#debug-text`)

| Section      | Fields                                                        |
| ------------ | ------------------------------------------------------------- |
| Position     | XYZ (float), Block coords (int)                               |
| Facing       | Cardinal 8-way (N/NE/E …), yaw °, pitch °                     |
| Target block | Block type name, world coords, chunk + local coords, face hit |

Cardinal direction from yaw:

```
yaw = 0   → -Z = North
yaw = π/2 → +X = East
8 bins of 45° each, round-nearest
```

A raycast is run every frame (max 6 blocks) to populate the Target section.

#### 3-D compass canvas (`#debug-compass`, 96 × 96 px)

Draws the three world axes (X=red Y=green Z=blue) projected onto 2D using the
camera's yaw + pitch as a simplified view transform:

```
screenX = right · worldVec   (right = [cos yaw, 0, sin yaw])
screenY = viewUp · worldVec  (approx camera-space up)
depth   = forward · worldVec (used for painter's-algorithm sort)
```

Axes are sorted back-to-front so closer arrows paint over farther ones.
Negative half-axes are drawn at 55 % length in a dark tint.
A white centre dot anchors the origin.

### Controls (updated)

| Key / Button | Action                                |
| ------------ | ------------------------------------- |
| F3           | Toggle debug overlay                  |
| LMB          | Break the targeted block              |
| RMB          | Place selected block on targeted face |
| E            | Cycle selected block type             |
| Space        | Jump                                  |
| WASD         | Walk                                  |
| Mouse        | Look                                  |

---

## Step 13 – Frustum Culling (`src/frustum.ts`)

### Why frustum culling?

Even with only 16 chunks the GPU processes every one per frame. Once the world
becomes large (infinite terrain), skipping invisible chunks becomes critical.
Frustum culling is a pure-CPU test, so it eliminates `gl.drawArrays` calls
before they ever reach the GPU driver.

### Gribb / Hartmann plane extraction

Given the combined VP matrix (column-major as gl-matrix produces), 6 clip-space
planes can be read directly from pairs of matrix rows:

```
gl-matrix column-major layout:
  row 0 = [m[0], m[4], m[8],  m[12]]
  row 1 = [m[1], m[5], m[9],  m[13]]
  row 2 = [m[2], m[6], m[10], m[14]]
  row 3 = [m[3], m[7], m[11], m[15]]

Left   = row3 + row0
Right  = row3 − row0
Bottom = row3 + row1
Top    = row3 − row1
Near   = row3 + row2
Far    = row3 − row2
```

Each plane is stored as `(A, B, C, D)`. A world-space point `p` (with `w=1`) is
_inside_ when `A·px + B·py + C·pz + D ≥ 0`.

### AABB test – p-vertex optimisation

For each of the 6 planes, pick the AABB corner that is furthest _in the direction
of the plane normal_ (the **p-vertex**):

```
px = A ≥ 0 ? maxX : minX
py = B ≥ 0 ? maxY : minY
pz = C ≥ 0 ? maxZ : minZ

if  A·px + B·py + C·pz + D < 0  →  AABB is entirely outside → cull
```

If the p-vertex (the most optimistic corner) still fails, every corner is outside
— so we can skip the whole chunk. The test is conservative: it never culls a
visible chunk, but may occasionally pass one just outside a frustum edge.

### Integration in renderer

Each frame:

```
1. viewMatrix  = camera.getViewMatrix()
2. projMatrix  = camera.getProjectionMatrix(aspect)
3. vpMatrix    = projMatrix × viewMatrix   (mat4.multiply)
4. frustum.update(vpMatrix)
5. for each chunk:
     if !frustum.containsAABB(wx0,0,wz0, wx0+16,16,wz0+16) → skip
     else → draw + drawCalls++
```

### F3 overlay

The debug panel now shows three extra lines at the top:

```
Renderer
FPS    60
Chunks 9 / 16  (7 culled)
```

---

## Step 14 — Tailwind CSS v4 + FlyonUI + Browser System Info

### Goals

1. Replace hand-rolled CSS with **Tailwind CSS v4** (CSS-first, no config file).
2. Add **FlyonUI** for styled keyboard-key (`kbd`) components in the HUD.
3. Enrich the **F3 debug panel** with one-time browser environment stats.

### Tailwind v4 setup

Tailwind v4 uses a _CSS-first_ configuration approach — no `tailwind.config.js`.

**`vite.config.ts`** (new file):

```ts
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({ plugins: [tailwindcss()] });
```

**`src/style.css`** — starts with:

```css
@import "tailwindcss";
@plugin "flyonui";
```

Tailwind's Vite plugin handles JIT scanning of all `.ts`/`.html` source files
automatically; no `content` array is needed.

### CSS decomposition

| Element                                           | Approach                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `html, body`                                      | `@layer base` with `@apply w-full h-full overflow-hidden bg-black`      |
| `#webglCanvas`                                    | `@apply block w-screen h-screen`                                        |
| `#crosshair`                                      | `@apply` for position/font + bare `text-shadow` (no utility equivalent) |
| `#debug-compass`                                  | `@apply` for position + explicit `width/height: 96px`                   |
| `#hotbar`, `#help`, `#debug-panel`, `#debug-text` | Tailwind utility classes on the HTML elements directly                  |
| `.dbg-section`                                    | `@apply font-bold text-yellow-300` (nested selector, stays in CSS)      |

### FlyonUI `kbd` component

Key hints in the HUD use the `kbd` / `kbd-sm` / `kbd-xs` component classes
provided by FlyonUI (DaisyUI v5 compatible):

```html
<kbd class="kbd kbd-xs">W</kbd> <kbd class="kbd kbd-sm">E</kbd>
```

`InputManager.updateHotbar()` uses `innerHTML` to inject `<kbd>` markup when
the held block type changes.

### Browser environment info — APIs used

| Info                | API                                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| GPU renderer        | `gl.getExtension("WEBGL_debug_renderer_info")` → `UNMASKED_RENDERER_WEBGL` |
| GPU vendor          | same extension → `UNMASKED_VENDOR_WEBGL`                                   |
| Max texture size    | `gl.getParameter(gl.MAX_TEXTURE_SIZE)`                                     |
| Max viewport dims   | `gl.getParameter(gl.MAX_VIEWPORT_DIMS)`                                    |
| CPU logical cores   | `navigator.hardwareConcurrency`                                            |
| Device RAM (approx) | `navigator.deviceMemory` (Chrome, returns GB bucket)                       |
| Browser + version   | `navigator.userAgent` regex extraction                                     |
| OS / platform       | `navigator.platform`                                                       |
| Screen resolution   | `screen.width × screen.height`                                             |
| Display pixel ratio | `window.devicePixelRatio`                                                  |
| Colour depth        | `screen.colorDepth`                                                        |

All values are captured once in `DebugOverlay` constructor (passed `gl`) and
stored in `this.sysInfo`. They are appended as a static **System** section at
the bottom of the F3 text pane every frame.

### F3 panel (full layout)

```
Renderer
FPS    144
Chunks 9 / 16  (7 culled)

Position
XYZ   32.00, 20.00, 32.00
Block  32, 20, 32

Facing
N   yaw 0.0°   pitch -17.2°

Target block
Dirt  (32, 18, 31)
chunk (2, 1)  local (0, 18, 15)
face  -Z (North)

System
GPU     ANGLE (NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0)
Vendor  Google Inc. (NVIDIA)
MaxTex  16384px  VP 32767×32767
CPU     16 logical cores
RAM     ~16 GB
Browser Chrome 136.0.7103.114
Screen  2560×1440  DPR ×1.50  24-bit
OS      Win32
```

---

## Future Steps (not implemented now)

| Feature           | Notes                                                               |
| ----------------- | ------------------------------------------------------------------- |
| Greedy meshing    | Merge coplanar same-type faces to cut vertex count ~70 %.           |
| Infinite terrain  | Stream chunks in/out as the player moves (Simplex noise heightmap). |
| Ambient occlusion | Darken vertices tucked into corners based on solid-neighbor count.  |
