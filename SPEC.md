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

- Remove any decorative nav/title so the canvas is the focus.
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

## Step 15 — Greedy Meshing

### Goal

Replace the naïve per-block face emitter with Mikola Lysenko's greedy meshing
algorithm to dramatically cut GPU vertex count on flat terrain.

### Why it matters

The naïve approach emits up to 6 quads (36 vertices) per solid block. On a
flat 16×16 layer of Grass, that is 256 quads just for the top faces. Greedy
meshing merges the entire layer into **one** quad (6 vertices), cutting vertex
count by ~98 % for flat surfaces and ~70 % overall on typical terrain.

### Algorithm

For each of the 6 face directions and for each slice perpendicular to that
direction:

1. **Build a 16×16 visibility mask** — each cell holds the atlas tile index of
   the visible face, or −1 if the face is hidden (neighbour is solid or the
   cell is Air).

2. **Greedy sweep** — scan the mask left-to-right, top-to-bottom. For each
   unvisited visible cell:
   - Grow **width** rightward as long as the next cell has the same tile index.
   - Grow **height** downward as long as every cell in the row matches.
   - Mark all merged cells as `used`.
   - Emit **one quad** for the merged rectangle (4 corners → 6 vertices).

3. Repeat for all slices and all 6 directions.

### Vertex data format change

| Field       | Old (vec3) | New (vec4)                            |
| ----------- | ---------- | ------------------------------------- |
| component 0 | atlas U    | **localU** (0 → quad width)           |
| component 1 | atlas V    | **localV** (0 → quad height)          |
| component 2 | light      | **tileIndex** (integer 0–3, as float) |
| component 3 | —          | **light** multiplier                  |

The **vertex shader** now computes atlas UV at runtime:

```glsl
const float TILE_W = 1.0 / 4.0;          // one tile's share of atlas width
v_uv = vec2(a_uvl.z * TILE_W + fract(a_uvl.x) * TILE_W,
            fract(a_uvl.y));
```

`fract()` tiles the 16 px atlas sprite across the merged quad, so a W×H quad
renders as W×H texture repetitions. Single-tile quads (W=H=1) behave
identically to the old pre-computed atlas UV approach.

### Face configuration table

Six `SliceDef` entries replace the old `FaceDef` / `FACES` table. Each entry
specifies the slice axis, two expansion axes, the neighbour direction, and the
face-plane offset:

| Face        | sliceAxis | dim0 | dim1 | normalSign | light |
| ----------- | --------- | ---- | ---- | ---------- | ----- |
| +Y (top)    | Y         | X    | Z    | +1         | 1.0   |
| -Y (bottom) | Y         | X    | Z    | −1         | 0.5   |
| +X (right)  | X         | Z    | Y    | +1         | 0.8   |
| -X (left)   | X         | Z    | Y    | −1         | 0.8   |
| +Z (front)  | Z         | X    | Y    | +1         | 0.7   |
| -Z (back)   | Z         | X    | Y    | −1         | 0.7   |

Winding rules for −X and −Z reverse the U axis along `dim0` so the texture
orientation matches the naïve mesher exactly.

### Renderer change

`gl.vertexAttribPointer(aUVL, 4, gl.FLOAT, false, 0, 0)` — size changed from 3
to 4.

### F3 debug panel addition

```
Renderer
FPS    144
Chunks 9 / 16  (7 culled)
Verts  12.4k / 23.1k
```

`drawnVertices` and `totalVertices` are summed in the render loop and passed
via `RenderStats`. They are displayed in thousands (`k`) for readability.

### Expected reduction (4×4 chunk world)

| Surface              | Naïve verts               | Greedy verts | Reduction |
| -------------------- | ------------------------- | ------------ | --------- |
| Flat grass top layer | 256 × 6 = 1 536 per chunk | 6 per chunk  | ~99 %     |
| Sinusoidal terrain   | varies                    | ~70 % fewer  | ~70 %     |

---

## Step 16 — Pixel-Art Textures + Block Selection Outline

### Goal

Replace the noisy procedural atlas with crisp pixel-art block textures, and
draw a wireframe selection outline around the block the player is looking at.

> **Historical note:** This step documents the WebGL-era 4-tile atlas setup.
> The current WebGPU/PBR pipeline uses a 12-tile multi-atlas material system
> (albedo + normal + specular), documented in **Step 18**.

### Texture atlas (`src/atlas.ts`)

The atlas generation is extracted from `renderer.ts` into its own module and
completely rewritten using `ImageData` for direct per-pixel control.

**Layout**: unchanged — 64×16 px canvas, 4 tiles of 16×16 px.

**Colour palettes** — 5 shades each, distributed by a noise value:

| Tile | Material   | Key design                                                         |
| ---- | ---------- | ------------------------------------------------------------------ |
| 0    | Grass top  | 5 greens, n<0.07→very dark, n>0.93→highlight                       |
| 1    | Grass side | Top 2 rows grass, rows 2–3 blended, rows 4–15 dirt                 |
| 2    | Dirt       | 5 earthy browns, noise distribution same as above                  |
| 3    | Stone      | Zone-based coarse gray (4×4 px zones) + fine noise + crack overlay |

**Stone crack lines** — 6 named cracks (A–F), each a hand-crafted sequence of
pixel coordinates, painted over the base gray at a darker value (82, 82, 82):

```
Crack A  (top-left diagonal):   [3,1]→[7,4]
Crack B  (top-right diagonal):  [10,0]→[14,3]
Crack C  (left mid):            [0,8]→[3,11]
Crack D  (right mid):           [13,7]→[15,9]
Crack E  (bottom-left):         [4,13]→[7,15]
Crack F  (bottom-right):        [10,11]→[14,12]
```

**Upload**: same as before — `UNPACK_FLIP_Y_WEBGL=true`, `NEAREST` filtering.

### Block-selection outline

A semi-transparent wireframe cube drawn each frame around the raycast-hit block.

#### Shaders (`src/shaders/outline/`)

| File                          | Contents                                |
| ----------------------------- | --------------------------------------- |
| `outline_VERTEXSHADER.glsl`   | MVP transform only, `vec3 a_position`   |
| `outline_FRAGMENTSHADER.glsl` | `vec4(0.0, 0.0, 0.0, 0.75)` flat colour |

Registered as `Materials.Outline` in `shader-materials.ts`.

#### Wire-cube geometry (`createWireCube`)

12 edges × 2 vertices = **24 vertices** built as a static `gl.STATIC_DRAW`
buffer. The cube is slightly expanded by ε = 0.002 on every side so the lines
sit just outside the block surface:

```
lo = -0.002,  hi = 1.002
```

Edges in vertex order: 4 bottom-face edges, 4 top-face edges, 4 vertical
edges — matching gl.LINES pair format.

#### Render pass

After all chunk draw calls, each frame:

1. Perform DDA raycast (same as debug overlay — cheap at 6 block max distance).
2. If no hit, skip.
3. Translate model matrix to `(hit.bx, hit.by, hit.bz)`.
4. Set GL state:
   - `gl.disable(gl.CULL_FACE)` — all 12 edges visible
   - `gl.disable(gl.DEPTH_TEST)` — always visible, won't fight block faces
   - `gl.enable(gl.BLEND)` + `gl.blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`
5. Draw 24 vertices with `gl.LINES`.
6. Restore state (`CULL_FACE`, `DEPTH_TEST`, `BLEND` off).

`gl.lineWidth(2.0)` is called as a hint; most WebGL implementations cap it at
1 px due to DirectX/Metal backend limitations.

---

## Step 17 — WebGPU Backend + Runtime Fallback

### Goal

Add a first-class WebGPU renderer while preserving the existing WebGL2 path
as an automatic fallback.

### Runtime selection (`src/main.ts`)

Startup now attempts backends in this order:

1. If `navigator.gpu` is available, construct `WebGPURenderer` and call `start()`.
2. If WebGPU init fails (or API is unavailable), fall back to `initializeCanvas()`
  and the legacy `EngineRenderer` (WebGL2).

This keeps browser compatibility while allowing modern GPU features where
supported.

### New backend structure

The WebGPU path is implemented in `src/webgpu/renderer.ts` with shader modules
under `src/webgpu/shaders/`.

Core additions:

- `src/renderer-interface.ts` — common `IRenderer` abstraction.
- `src/webgpu/shaders/outline.wgsl` — wireframe selection cube.
- `src/webgpu/shaders/tonemap.wgsl` — fullscreen ACES tonemap pass.

### Camera projection update

`Camera` now exposes `getProjectionMatrixZO(aspect)` using
`mat4.perspectiveZO(...)` for WebGPU clip-space depth (`z ∈ [0, 1]`).

The WebGPU renderer uses this ZO projection for GPU uniforms and depth
reconstruction while keeping existing camera behavior unchanged.

---

## Step 18 — Deferred PBR Pipeline (labPBR-style defaults)

### Goal

Replace forward voxel shading in the WebGPU backend with a deferred lighting
pipeline that supports normal/specular material channels and physically based
lighting terms.

### Render pipeline (WebGPU)

Per-frame pass order:

1. **GBuffer pass** (`gbuffers_terrain.wgsl`) — writes 3 MRT targets + depth.
2. **Deferred lighting pass** (`deferred_lighting.wgsl`) — evaluates
  Cook-Torrance BRDF from GBuffer.
3. **Outline pass** (`outline.wgsl`) — block-selection wireframe over lit scene.
4. **Tonemap pass** (`tonemap.wgsl`) — HDR to swapchain when HDR is enabled.

### GBuffer outputs

`gbuffers_terrain.wgsl` writes:

- `colortex0` (`rgba8unorm`): `rgb = albedo`, `a = roughness`
- `colortex1` (`rgba16float`): `rgb = view normal (encoded 0..1)`, `a = F0`
- `colortex2` (`rgba8unorm`): `rgb = emissive`, `a = AO`
- `depth24plus`: scene depth for deferred reconstruction and outline occlusion

### Material atlas system

Atlas provisioning now supports three channels:

- Dimensions: **192×16** (12 tiles × 16 px)

- **Albedo atlas** — texture images loaded from block assets.
- **Normal atlas** — generated default flat map (`128,128,255,255`).
- **Specular atlas** — generated default map (`0,25,0,255`).

Implemented in `src/atlas.ts` via:

- `buildAtlasCanvas()`
- `buildNormalAtlasCanvas()`
- `buildSpecularAtlasCanvas()`
- `buildAllAtlases()`

### Chunk mesh vertex format extension

`ChunkMesh` now contains four streams:

- `positions` (`vec3`)
- `uvls` (`vec4`: localU, localV, tileIndex, bakedLight)
- `normals` (`vec3`)
- `tangents` (`vec4`: tangent.xyz + bitangentSign)

`src/world/chunk.ts` now emits per-face TBN basis data (`FACE_TBN`) so normal
maps can be transformed correctly in the GBuffer shader.

### Deferred lighting model

`deferred_lighting.wgsl` computes:

- GGX normal distribution
- Smith-Schlick geometry term
- Fresnel-Schlick reflectance
- Lambertian diffuse (suppressed for metallic materials)
- Ambient + fog blending

Depth reconstruction uses `projInv` from the frame UBO (ZO projection path).

### Frame UBO expansion

WebGPU frame uniforms were expanded to carry deferred inputs:

- `view`, `projection`, `viewInv`, `projInv`
- `sunDirStrength`, `sunColor`
- `ambientColor`
- `fogColorNear`, `fogFar`

This UBO is shared across GBuffer, deferred, and outline passes.

### Notes

- Current PBR behavior uses generated defaults for `_n`/`_s` when pack-specific
  textures are not provided yet.
- Shadow mapping is not part of this step and remains future work.

---

## Step 19 — Resource Pack PBR Ingestion (labPBR `_n` / `_s`)

### Goal

Load real PBR material textures from resource packs instead of relying on
generated fallback normal/specular atlases.

### Scope

1. Add a texture resolver that maps each block tile name to:
  - albedo: `name.png`
  - normal: `name_n.png`
  - specular: `name_s.png`
2. Build atlases from the resolved texture set with fallback chain:
  - pack texture → base project texture → generated default.
3. Support hot-reload / runtime pack swap by rebuilding GPU textures and bind
  groups without restarting the renderer.

### Implementation status (started)

Implemented in this phase:

- `src/resource-pack.ts` introduces `ResourcePackManager`.
- `src/atlas.ts` now supports manifest-based atlas builds via
  `buildAllAtlasesFromManifest(manifest)`.
- Fallback counters are emitted during renderer startup:
  `albedoFallbacks`, `normalFallbacks`, `specularFallbacks`.
- `src/webgpu/renderer.ts` consumes optional runtime globals:

```ts
window.__PBR_TEXTURE_MANIFEST__ = {
  albedo:   { grass_block_top: "/packs/a/grass_block_top.png" },
  normal:   { grass_block_top: "/packs/a/grass_block_top_n.png" },
  specular: { grass_block_top: "/packs/a/grass_block_top_s.png" },
};
// or
window.__PBR_PACK_BASE_URL = "/packs/a/textures/block";
```

Not implemented yet:

- UI-driven pack selection / upload flow.
- Live in-session atlas swap and bind-group rebuild without restart.

### Deliverables

- `ResourcePackManager` module with async index + load APIs.
- Atlas build path updated to accept an explicit texture manifest.
- Debug panel section showing active pack name and missing-PBR fallback counts.

### Exit criteria

- A block with valid `_n` and `_s` in the pack visibly changes roughness and
  normal response in scene lighting.
- Missing maps fall back per-tile without rendering errors.

---

## Step 20 — Shadow Mapping for Deferred Lighting

### Goal

Add directional shadowing (sun/moon) to the deferred PBR path.

### Scope

1. Add a shadow depth pass (terrain-only first).
2. Extend frame uniforms with shadow view/projection matrices and light-space
  transform.
3. Sample shadow map in deferred pass with depth comparison and bias.
4. Add optional 2×2 PCF filtering toggle.

### Deliverables

- `shadow_terrain.wgsl` depth-only pipeline.
- Deferred shader update with shadow factor multiplication on direct light.
- Settings toggle: `Shadows` + `Shadow Quality (off/basic/pcf)`.

### Exit criteria

- Terrain self-shadowing tracks sun direction across day cycle.
- No major acne/peter-panning at default bias settings.

---

## Step 21 — Iris Compatibility Layer (Phase 1)

### Goal

Execute a constrained subset of Iris shaderpack programs using the existing
WebGPU render graph.

### Scope (Phase 1 subset)

- `gbuffers_terrain`
- `deferred`
- `composite`
- `final`

### Contract source of truth

Implementation follows the interfaces defined in `SHADER.md`:

- uniform naming and packing
- sampler/colortex binding layout
- supported preprocessor macros
- pass ordering and fallback rules

### Deliverables

- Shaderpack parser (`.vsh` / `.fsh` + `shaders.properties`).
- GLSL preprocessing + macro injection.
- GLSL→WGSL transpile/compile stage with diagnostics surfaced in debug UI.
- Program fallback logic to built-in shaders when pack stage is missing.

### Exit criteria

- A minimal Iris-targeted pack can run terrain + one deferred/composite stage.
- Missing programs degrade gracefully without crashing frame execution.

---

## Step 22 — Validation Matrix & Compatibility Gates

### Goal

Prevent regressions while expanding PBR/shaderpack support.

### Test matrix

- Backends: WebGPU primary, WebGL2 fallback
- Packs: no-pack defaults, partial PBR pack, full PBR pack
- Features: HDR on/off, shadows on/off, tonemap exposure range

### Required checks per release

1. `bun run build` succeeds.
2. TypeScript check is clean.
3. GPU shader compile log has no errors.
4. Golden-scene screenshot diff is within tolerance.

### Exit criteria

- All matrix combinations render and remain interactive.
- Known unsupported Iris stages are explicitly reported, not silently broken.

---

## Future Steps (not implemented now)

| Feature           | Notes                                                               |
| ----------------- | ------------------------------------------------------------------- |
| Infinite terrain  | Stream chunks in/out as the player moves (Simplex noise heightmap). |
| Ambient occlusion | Darken vertices tucked into corners based on solid-neighbor count.  |
