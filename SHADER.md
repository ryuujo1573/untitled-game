# Shader Compatibility Specification

This document defines the compatibility contract between **roughly-a-3d-game** and:

1. **Minecraft labPBR PBR resource packs** (normal maps, specular maps) — the texture layer
   protocol used by Iris/OptiFine-targeted packs like Vanilla PBR, Patrix, etc.
2. **Iris-compatible shaderpacks** — the GLSL program protocol that Iris/OptiFine expose
   to shader authors (uniforms, samplers, vertex attributes, render pass ordering).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [labPBR Material Standard (v1.3)](#labpbr-material-standard-v13)
3. [Supported Iris Shader Programs](#supported-iris-shader-programs)
4. [Uniform Contract](#uniform-contract)
5. [Texture Sampler Bindings](#texture-sampler-bindings)
6. [Vertex Attribute Contract](#vertex-attribute-contract)
7. [GBuffer Layout](#gbuffer-layout)
8. [Buffer Configuration Directives](#buffer-configuration-directives)
9. [shaders.properties Subset](#shadersproperties-subset)
10. [Block ID Mapping](#block-id-mapping)
11. [Macro Definitions](#macro-definitions)
12. [Known Limitations](#known-limitations)

---

## Architecture Overview

The engine uses **WebGPU** as the primary backend (WebGL2 retained as fallback).
Shaderpacks are written in **GLSL** (compatible with Iris/OptiFine).
The engine transpiles GLSL → WGSL via **Naga** WASM before feeding them to
`GPUDevice.createShaderModule()`.

### Render Pass Execution Order

```
[shadow pass]          → shadowtex0 / shadowtex1 depth textures
                            ↓
[gbuffers_skybasic]    → colortex0 (sky colour / horizon)
[gbuffers_terrain]     → colortex0-3, depthtex0
[gbuffers_water]       → colortex0-3, depthtex0
[gbuffers_basic]       → colortex0
                            ↓
[deferred] × N         → reads colortex0-7, depthtex0; writes colortex0-7
                            ↓
[composite] × N        → reads colortex0-15, depthtex0-2; writes colortex0-7
                            ↓
[final]                → reads colortex0 → outputs to swap-chain / canvas
```

---

## labPBR Material Standard (v1.3)

labPBR is the dominant PBR texture format used by Minecraft resource packs targeting
Iris/OptiFine shaders. This engine reads labPBR textures from the loaded resource pack.

### Texture File Naming Convention

| Texture role | File suffix / pattern     | Example                        |
|---|---|---|
| Albedo / diffuse | _(base name)_ | `grass_block_side.png` |
| Normal + AO + height | `_n` suffix | `grass_block_side_n.png` |
| Specular / PBR | `_s` suffix | `grass_block_side_s.png` |

The engine scans `resourcepack/assets/minecraft/textures/block/` (and any namespace)
for these suffixed files. Packs declare their PBR format in `texture.properties`:

```properties
format=lab-pbr
version=1.3
```

### Normal Map (`_n` texture) — DirectX convention (Y−)

| Channel | Content | Linear encoding |
|---|---|---|
| **R** | Normal X | `nx = R / 255.0 * 2.0 − 1.0`  (0 = left, 255 = right) |
| **G** | Normal Y | `ny = G / 255.0 * 2.0 − 1.0`  (0 = up, 255 = down — DirectX Y-flip) |
| **B** | Material AO | `ao = B / 255.0`  (0 = fully occluded, 255 = no occlusion) |
| **A** | Height / displacement | `h = A / 255.0`  (0 = maximum depth ~25%, 255 = surface level). Min value = 1 (avoid POM artefacts). |

Normal Z is **not stored** — it is reconstructed in the shader:

```glsl
vec2 nxy = texture(normals, uv).rg * 2.0 - 1.0;
float nz  = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
vec3 tsNormal = normalize(vec3(nxy, nz));
```

### Specular Map (`_s` texture)

| Channel | Content | Linear encoding |
|---|---|---|
| **R** | Perceptual smoothness | `smoothness = R / 255.0` |
| **G** | F0 or hardcoded metal | 0–229 = dielectric F0 `(G/229.0 * 0.898)`; 230–254 = metal index; 255 = generic metal (albedo = F0) |
| **B** | Porosity / SSS | 0–64 = porosity `(B/64)`; 65–255 = subsurface scattering `((B−65)/190)` |
| **A** | Emissive | 0–254 = emission intensity `(A/254)`; **255 = no emission** (default) |

#### Smoothness ↔ Roughness

$$\text{roughness} = (1 - \text{smoothness})^2$$
$$\text{smoothness} = 1 - \sqrt{\text{roughness}}$$

where `smoothness = texel.r / 255.0`.

#### Hardcoded Metal Table (F0 N/K values)

| texel.g | Metal      | N (R, G, B)                 | K (R, G, B)                 |
|---|---|---|---|
| 230 | Iron       | 2.9114, 2.9497, 2.5845      | 3.0893, 2.9318, 2.7670      |
| 231 | Gold       | 0.18299, 0.42108, 1.3734    | 3.4242, 2.3459, 1.7704      |
| 232 | Aluminum   | 1.3456, 0.96521, 0.61722    | 7.4746, 6.3995, 5.3031      |
| 233 | Chrome     | 3.1071, 3.1812, 2.3230      | 3.3314, 3.3291, 3.1350      |
| 234 | Copper     | 0.27105, 0.67693, 1.3164    | 3.6092, 2.6248, 2.2921      |
| 235 | Lead       | 1.9100, 1.8300, 1.4400      | 3.5100, 3.4000, 3.1800      |
| 236 | Platinum   | 2.3757, 2.0847, 1.8453      | 4.2655, 3.7153, 3.1365      |
| 237 | Silver     | 0.15943, 0.14512, 0.13547   | 3.9291, 3.1900, 2.3808      |

#### Dielectric F0 Encoding

Values 0–229 represent a dielectric's reflectance at normal incidence:

```
f0 = (G / 229.0) * 0.898   → maps [0, 229] to [0.0, 0.898]
```

#### Porosity Reference Values

| Material | Porosity (G value) |
|---|---|
| Sand     | 64 |
| Wool     | 38 |
| Wood     | 12 |
| Metal / glass | 0 |

---

## Supported Iris Shader Programs

Only the programs listed below are supported. Programs not listed are silently skipped;
their geometry falls back as shown.

| Program | Geometry rendered | Fallback |
|---|---|---|
| `shadow` | All opaque + cutout terrain (sun/moon ortho perspective) | _(no fallback — shadow pass omitted if absent)_ |
| `shadow_solid` | Solid terrain in shadow pass | `shadow` |
| `shadow_cutout` | Cutout terrain in shadow pass | `shadow` |
| `gbuffers_basic` | Block selection outline | _(none)_ |
| `gbuffers_skybasic` | Sky colour, horizon gradient, stars, void | `gbuffers_basic` |
| `gbuffers_skytextured` | Sun disk, moon disk textures | `gbuffers_skybasic` |
| `gbuffers_terrain` | Solid and cutout terrain blocks | `gbuffers_basic` |
| `gbuffers_water` | Translucent terrain (water, stained glass) | `gbuffers_terrain` |
| `gbuffers_clouds` | Vanilla cloud geometry | `gbuffers_basic` |
| `deferred` | First deferred lighting pass | _(fullscreen compute / fragment)_ |
| `deferred1` – `deferred3` | Additional deferred passes | _(fullscreen compute / fragment)_ |
| `composite` | First composite (post-processing) pass | _(fullscreen)_ |
| `composite1` – `composite3` | Additional composite passes | _(fullscreen)_ |
| `final` | Final output blit to canvas | _(if absent: `colortex0` blitted directly)_ |

**Not yet supported** (Phase 2+): `gbuffers_entities`, `gbuffers_hand`,
`gbuffers_armor_glint`, `gbuffers_block`, `gbuffers_weather`, `gbuffers_beaconbeam`.

### Shader File Extensions

| Stage | Extension |
|---|---|
| Vertex | `.vsh` |
| Fragment | `.fsh` |
| Compute | `.csh` |
| Geometry | `.gsh` _(not supported)_ |

All files are located under `shaders/` within the shaderpack ZIP or folder.

---

## Uniform Contract

All uniforms are packed into a single `UniformBuffer` per program change point
(gbuffers / deferred / composite). The CPU-side layout is 16-byte aligned.

### Matrices

| Uniform | Type | Description |
|---|---|---|
| `gbufferModelView` | `mat4` | Player-space → view-space |
| `gbufferModelViewInverse` | `mat4` | View-space → player-space |
| `gbufferProjection` | `mat4` | View-space → clip-space |
| `gbufferProjectionInverse` | `mat4` | Clip-space → view-space |
| `gbufferPreviousModelView` | `mat4` | Previous frame's `gbufferModelView` |
| `gbufferPreviousProjection` | `mat4` | Previous frame's `gbufferProjection` |
| `shadowModelView` | `mat4` | Player-space → shadow-view-space |
| `shadowModelViewInverse` | `mat4` | Shadow-view → player-space |
| `shadowProjection` | `mat4` | Shadow-view → shadow-clip-space |
| `shadowProjectionInverse` | `mat4` | Shadow-clip → shadow-view-space |
| `modelViewMatrix` | `mat4` | Model → view-space (per geometry object) |
| `normalMatrix` | `mat3` | Model → view-space for normals |

### Time

| Uniform | Type | Range | Description |
|---|---|---|---|
| `worldTime` | `int` | [0, 23999] | In-game time ticks (maps from engine's 0–1 cycle: `round(wt * 24000) % 24000`) |
| `worldDay` | `int` | [0, ∞) | Count of complete in-game days |
| `frameTimeCounter` | `float` | [0, 3600) | Running time in seconds (wraps at 1 hour) |
| `frameTime` | `float` | — | Previous frame duration in seconds |
| `frameCounter` | `int` | [0, 720719] | Frame index (wraps) |
| `sunAngle` | `float` | [0, 1] | Sun position in the day-night cycle |
| `moonPhase` | `int` | [0, 7] | Current moon phase (static 0 until lunar cycle is implemented) |

### Camera / Player

| Uniform | Type | Description |
|---|---|---|
| `cameraPosition` | `vec3` | World-space camera position |
| `previousCameraPosition` | `vec3` | Previous frame's camera position |
| `upPosition` | `vec3` | Up direction in view-space (length 100) |
| `eyeAltitude` | `float` | Y coordinate of the camera |
| `eyeBrightness` | `ivec2` | Light level at camera: (block, sky) in [0, 240] |
| `eyeBrightnessSmooth` | `ivec2` | Smoothed eye brightness |

### Lighting / Sky

| Uniform | Type | Description |
|---|---|---|
| `sunPosition` | `vec3` | Sun position in view-space (length 100) |
| `moonPosition` | `vec3` | Moon position in view-space (length 100) |
| `shadowLightPosition` | `vec3` | Active shadow light (sun or moon) in view-space (length 100) |

### Screen

| Uniform | Type | Description |
|---|---|---|
| `viewWidth` | `float` | Canvas width in pixels |
| `viewHeight` | `float` | Canvas height in pixels |
| `aspectRatio` | `float` | `viewWidth / viewHeight` |
| `near` | `float` | Near clip plane (0.1) |
| `far` | `float` | Far clip plane (500.0) |
| `screenBrightness` | `float` | Player brightness setting [0, 1] (maps from `Settings.brightness / 2`) |

### Fog

| Uniform | Type | Description |
|---|---|---|
| `fogColor` | `vec3` | Horizon fog colour (sky tint) |
| `skyColor` | `vec3` | Upper sky colour |
| `fogStart` | `float` | Fog start distance (40.0) |
| `fogEnd` | `float` | Fog end / full-fog distance (80.0) |
| `fogMode` | `int` | `9729` = GL_LINEAR |
| `fogShape` | `int` | `1` = cylinder |
| `fogDensity` | `float` | 1.0 |

### Weather

| Uniform | Type | Description |
|---|---|---|
| `rainStrength` | `float` | Current rain intensity [0, 1] (0.0 until weather system is implemented) |
| `wetness` | `float` | Smoothed rain strength |
| `thunderStrength` | `float` | Thunderstorm intensity [0, 1] (0.0) |

### Render State

| Uniform | Type | Description |
|---|---|---|
| `alphaTestRef` | `float` | Alpha discard threshold (0.1) |
| `atlasSize` | `ivec2` | Texture atlas resolution in pixels |
| `renderStage` | `int` | Numeric identifier for current render stage (matches `MC_RENDER_STAGE_*`) |

---

## Texture Sampler Bindings

### GBuffers Programs

| Sampler name | WebGPU binding group/slot | Content |
|---|---|---|
| `gtexture` / `texture` | group 2, binding 0 | Albedo atlas (the main colour atlas) |
| `lightmap` | group 2, binding 1 | Lightmap (flat white 16×16 until baked lighting is implemented) |
| `normals` | group 2, binding 2 | `_n` normal/AO atlas |
| `specular` | group 2, binding 3 | `_s` PBR specular atlas |
| `shadowtex0` | group 2, binding 4 | Shadow depth (all geometry) |
| `shadowtex1` | group 2, binding 5 | Shadow depth (opaque only) |
| `depthtex0` | group 2, binding 6 | Scene depth (all geometry) |
| `depthtex1` | group 2, binding 11 | Scene depth (no translucent) |
| `noisetex` | group 2, binding 15 | Noise texture (256×256 blue noise) |

### Composite / Deferred / Final Programs

The 8 colour buffers (`colortex0`–`colortex7`) plus depth and shadow buffers are all
available. Buffer indices map to WebGPU texture binding slots as follows:

| Sampler name | Binding slot | Default format | Clear behaviour |
|---|---|---|---|
| `colortex0` / `gcolor` | 0 | `rgba16float` | Cleared to sky/fog colour |
| `colortex1` / `gdepth` | 1 | `rgba32float` | Cleared to `vec4(1.0)` |
| `colortex2` / `gnormal` | 2 | `rgba16float` | Cleared to `vec4(0.0)` |
| `colortex3` / `composite` | 3 | `rgba16float` | Cleared to `vec4(0.0)` |
| `colortex4` / `gaux1` | 7 | `rgba8unorm` | Cleared to `vec4(0.0)` |
| `colortex5` / `gaux2` | 8 | `rgba8unorm` | Cleared to `vec4(0.0)` |
| `colortex6` / `gaux3` | 9 | `rgba8unorm` | Cleared to `vec4(0.0)` |
| `colortex7` / `gaux4` | 10 | `rgba8unorm` | Cleared to `vec4(0.0)` |
| `shadowtex0` | 4 | `depth32float` | — |
| `shadowtex1` | 5 | `depth32float` | — |
| `depthtex0` | 6 | `depth32float` | — |
| `depthtex1` | 11 | `depth32float` | — |
| `shadowcolor0` | 13 | `rgba8unorm` | — |
| `noisetex` | 15 | `rgba8unorm` | — |

---

## Vertex Attribute Contract

GBuffers vertex shaders may declare these `in` variables (GLSL 330+ syntax):

| Attribute | Type | `@location` | Description |
|---|---|---|---|
| `vaPosition` / `a_position` | `vec3` | 0 | Vertex position in chunk-local space |
| `vaColor` | `vec4` | 1 | Vertex colour (packed RGBA, default `vec4(1.0)`) |
| `vaUV0` | `vec2` | 2 | Primary texcoord (atlas UV) |
| `vaUV2` | `ivec2` | 3 | Lightmap texcoord — `ivec2(240, 240)` until baked lighting |
| `vaNormal` | `vec3` | 4 | Per-face normal in model-space |
| `at_tangent` | `vec4` | 5 | Tangent vector (xyz) + bitangent sign (w = ±1) |
| `mc_Entity` | `vec2` | 6 | `x` = block numeric ID (from `block.properties`); `y` = 0 |
| `mc_midTexCoord` | `vec2` | 7 | Mid-sprite UV (atlas UV at the centre of the tile) |
| `a_uvl` | `vec4` | 8 | Internal: xy = local quad UV, z = tileIndex, w = baked face light |

> **Legacy aliases**: `gl_Vertex`, `gl_Color`, `gl_Normal`, `gl_MultiTexCoord0` are
> **not** supported. Use the `va*` / `at_*` / `mc_*` names.

---

## GBuffer Layout

The default internal GBuffer used before shaderpacks are loaded:

| Attachment | `@location` | Format | Content |
|---|---|---|---|
| Albedo + Metallic | 0 | `rgba8unorm` | RGB = albedo, A = metallic (0/1 from `_s` G channel) |
| View-Normal + Roughness | 1 | `rgba16float` | XYZ = view-space normal, W = roughness (from `_s` R channel) |
| Emissive + AO | 2 | `rgba8unorm` | RGB = emissive colour, A = AO (from `_n` B channel) |
| Motion Vectors | 3 | `rg16float` | Screen-space motion (future TAA use) |
| Depth | — | `depth24plus` | Scene depth |

Shaderpacks may redeclare GBuffer formats via the `colortexNFormat` const:

```glsl
// In any .fsh or .vsh file:
const int colortex0Format = RGBA16F;
const int colortex2Format = RGBA32F;
```

Supported format tokens: `RGBA8`, `RGBA16`, `RGBA16F`, `RGBA32F`, `RG16F`,
`R11F_G11F_B10F`, `RGB10_A2`.

---

## Buffer Configuration Directives

### DRAWBUFFERS / RENDERTARGETS

Declare write targets as a comment in the **fragment shader**:

```glsl
/* DRAWBUFFERS:023 */          // writes to colortex0, colortex1, colortex3 (digits only, 0-9)
/* RENDERTARGETS: 0,2,11,15 */ // writes to colortex0, colortex2, colortex11, colortex15 (comma-separated, 0-15)
```

With GLSL 130+ named outputs:

```glsl
/* RENDERTARGETS: 0,1,2 */
out vec4 outColor0;  // → colortex0
out vec4 outColor1;  // → colortex1
out vec4 outColor2;  // → colortex2
```

Maximum **8 simultaneous** write targets.

### Buffer Clear Control

```glsl
const bool colortex5Clear      = false;         // disable auto-clear between frames
const vec4 colortex5ClearColor = vec4(0.5, 0.5, 0.5, 1.0);
```

### Buffer Flip (ping-pong)

```properties
# shaders.properties
flip.composite.colortex4=true
flip.composite1.colortex4=false
```

---

## shaders.properties Subset

The following keys are read from `shaders/shaders.properties`:

### Shadow

```properties
shadowMapResolution=1024     # shadow texture width = height (power of 2, default 1024)
shadowDistance=128.0         # shadow render distance in blocks
shadowDistanceRenderMul=1.0  # set > 0 to enable distance-based shadow culling
shadowIntervalSize=2.0       # snaps shadow camera to avoid shimmer
shadow.enabled=true          # globally enable / disable shadow pass
shadowTerrain=true           # render terrain in shadow
shadowTranslucent=false      # render translucent terrain in shadow
shadowEntities=false         # (not yet supported)
```

### Sun / Atmosphere

```properties
sunPathRotation=0.0          # rotate sun/moon orbital plane (degrees, default 0)
clouds=fancy                 # fast | fancy | off
sun=true
moon=true
```

### Fog & Wetness

```properties
wetnessHalflife=600.0        # rain smoothing half-life in ticks
drynessHalflife=200.0
```

### Program Alpha Tests

```properties
alphaTest.gbuffers_terrain=GREATER 0.1
alphaTest.gbuffers_water=GREATER 0.0
```

### Blend Functions (per program, per buffer)

```properties
blend.gbuffers_water=SRC_ALPHA ONE_MINUS_SRC_ALPHA ONE ONE
blend.composite.colortex0=ADD ONE ONE
```

### User-Configurable Options

Options declared with `option.*` appear in the shader pack settings screen.
The engine reads their current values and injects corresponding `#define` macros.

```properties
option.SHADOW_QUALITY=1      # integer option with default 1
option.AMBIENT_OCCLUSION=ON  # boolean option
screen=SHADOW_QUALITY AMBIENT_OCCLUSION
```

### Custom Uniforms

```properties
uniform.float.customTime=frameTimeCounter * 0.5
variable.float.myVar=sin(frameTimeCounter)
uniform.vec3.customColor=vec3(myVar, 0.0, 1.0)
```

These are evaluated on the CPU per frame and uploaded to the shader program.

---

## Block ID Mapping

Defined in `shaders/block.properties` within the shaderpack:

```properties
block.1=minecraft:grass_block    # numeric ID 1 → grass_block
block.2=minecraft:dirt
block.3=minecraft:stone
block.4=minecraft:coal_ore
block.5=minecraft:iron_ore
block.6=minecraft:gold_ore
block.7=minecraft:diamond_ore
block.8=minecraft:emerald_ore
block.9=minecraft:lapis_ore
block.10=minecraft:redstone_ore
block.11=minecraft:copper_ore
```

These IDs are passed to shaders via the `mc_Entity.x` vertex attribute.
The engine's internal `BlockType` enum values map to the IDs above.

---

## Macro Definitions

The following `#define` macros are injected immediately after the `#version` directive:

### Engine Identity

```glsl
#define ROUGHLY_A_3D_GAME 1
#define ENGINE_VERSION 1        // incremented with API-breaking changes
```

### Feature Flags

```glsl
#define MC_NORMAL_MAP            // defined when _n atlas is loaded
#define MC_SPECULAR_MAP          // defined when _s atlas is loaded
#define MC_TEXTURE_FORMAT_LAB_PBR     // defined when pack declares lab-pbr format
#define MC_TEXTURE_FORMAT_LAB_PBR_1_3 // defined when version >= 1.3
```

### Render Stage Constants (`renderStage` uniform values)

```glsl
#define MC_RENDER_STAGE_NONE            0
#define MC_RENDER_STAGE_SKY             1
#define MC_RENDER_STAGE_SUNSET          2
#define MC_RENDER_STAGE_STARS           3
#define MC_RENDER_STAGE_VOID            4
#define MC_RENDER_STAGE_TERRAIN_SOLID   5
#define MC_RENDER_STAGE_TERRAIN_CUTOUT  6
#define MC_RENDER_STAGE_TERRAIN_TRANSLUCENT 7
#define MC_RENDER_STAGE_WATER           8
#define MC_RENDER_STAGE_SHADOW          9
```

### Platform

```glsl
#define MC_GL_VERSION  460      // reported OpenGL/GLSL version target for transpiler
#define MC_GLSL_VERSION 460
// OS: exactly one of:
#define MC_OS_WINDOWS
#define MC_OS_MAC
#define MC_OS_LINUX
// WebGPU backend:
#define MC_BACKEND_WEBGPU 1
```

### Shader Quality (from `shaders.properties`)

```glsl
#define MC_SHADOW_QUALITY     1.0   // 0.5 / 1.0 / 2.0
#define MC_RENDER_QUALITY     1.0   // 0.5 / 1.0 / 2.0
```

---

## Known Limitations

| Feature | Status |
|---|---|
| Entity rendering (mobs, players) | Not implemented — engine has no entity system yet |
| Block entities (chests, signs) | Not implemented |
| Hand/held item rendering | Not implemented |
| Particle system | Not implemented |
| Weather geometry (rain, snow) | Not implemented |
| Biome uniforms (`biome`, `temperature`, etc.) | Always 0 |
| `eyeBrightness` / lightmap | Flat `(240, 240)` — no baked lighting yet |
| Geometry shaders (`.gsh`) | Not supported (WebGPU has no geometry shader stage) |
| Tessellation (`.tcs` / `.tes`) | Not supported |
| Hard-coded metal per-texel IOR rendering | Metal index table read but BRDF uses Fresnel-Schlick approximation |
| `#include` in GLSL | Supported (resolved before transpilation) |
| Custom images (`image.*` in shaders.properties) | Phase 3+ |
| SSBOs (`bufferObject.*`) | Phase 4+ |
| Compute shaders in shaderpacks (`.csh`) | Phase 3+ |
| GLSL version | `#version 120` through `#version 460` accepted |
| Multi-draw indirect | Phase 4+ (GPU-driven rendering) |
