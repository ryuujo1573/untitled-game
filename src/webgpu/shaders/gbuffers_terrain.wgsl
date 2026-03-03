// =============================================================================
// gbuffers_terrain.wgsl
//
// GBuffer terrain pass — fills four render targets with material data that
// the deferred_lighting pass will consume.
//
// Bind groups:
//   Group 0:
//     0 — GFrameUniforms UBO (336 bytes)
//     1 — albedo atlas   (texture_2d<f32>)
//     2 — normal atlas   (texture_2d<f32>, labPBR _n convention)
//     3 — specular atlas (texture_2d<f32>, labPBR _s convention)
//     4 — sampler (nearest / clamp-to-edge)
//   Group 1:
//     0 — ChunkUniforms UBO (64 bytes, per-chunk model matrix)
//
// Vertex buffer slots:
//   0 — position (vec3f, stride 12)
//   1 — uvl      (vec4f, stride 16) — xy=localUV, z=tileIdx, w=dirLight
//   2 — normal   (vec3f, stride 12) — object-space face normal
//   3 — tangent  (vec4f, stride 16) — xyz=T direction, w=bitangent sign
//   4 — lightmap (vec2f, stride  8) — x=skyLight/15, y=blockLight/15
//
// GBuffer layout:
//   @location(0) albedoRoughness  rgba8unorm  — rgb=albedo,       a=roughness
//   @location(1) normalMetallic   rgba16float — rgb=viewN[0,1],   a=F0
//   @location(2) emissiveAO       rgba8unorm  — rgb=emissive RGB, a=bakedAO
//   @location(3) lightmap         rgba8unorm  — r=skyLight/15, g=blockLight/15
// =============================================================================

// ── Uniforms ──────────────────────────────────────────────────────────────────

struct GFrameUniforms {
    view:           mat4x4f,   // bytes   0–63
    projection:     mat4x4f,   // bytes  64–127
    viewInv:        mat4x4f,   // bytes 128–191
    projInv:        mat4x4f,   // bytes 192–255
    sunDirStrength: vec4f,     // bytes 256–271  xyz=sunDir(view space), w=strength
    sunColor:       vec4f,     // bytes 272–287  xyz=color, w=unused
    ambientColor:   vec4f,     // bytes 288–303  xyz=color, w=scale
    fogColorNear:   vec4f,     // bytes 304–319  xyz=fogColor, w=fogNear
    fogFar:         vec4f,     // bytes 320–335  x=fogFar
}

struct ChunkUniforms {
    model: mat4x4f,
}

@group(0) @binding(0) var<uniform> frame:         GFrameUniforms;
@group(0) @binding(1) var          albedoAtlas:   texture_2d<f32>;
@group(0) @binding(2) var          normalAtlas:   texture_2d<f32>;
@group(0) @binding(3) var          specularAtlas: texture_2d<f32>;
@group(0) @binding(4) var          atlasSamp:     sampler;
@group(1) @binding(0) var<uniform> chunk:         ChunkUniforms;

// ── Vertex stage ──────────────────────────────────────────────────────────────

struct VsIn {
    @location(0) position: vec3f,
    @location(1) uvl:      vec4f,  // xy=localUV, z=tileIdx, w=dirLight
    @location(2) normal:   vec3f,
    @location(3) tangent:  vec4f,  // xyz=T direction, w=bitangent sign
    @location(4) lightmap: vec2f,  // x=skyLight/15, y=blockLight/15
}

struct VsOut {
    @builtin(position) clip:        vec4f,
    @location(0)       uvl:         vec4f,
    @location(1)       viewNormal:  vec3f,
    @location(2)       viewTangent: vec4f,  // xyz=T(view), w=bitangentSign
    @location(3)       lightmap:    vec2f,  // passed through to fragment
}

@vertex fn vs_main(in: VsIn) -> VsOut {
    let mv       = frame.view * chunk.model;
    let worldPos = chunk.model * vec4f(in.position, 1.0);
    let viewPos  = frame.view  * worldPos;
    let clipPos  = frame.projection * viewPos;

    // Normal matrix = upper-3×3 of (view × model). Valid for uniform-scale models.
    // In WGSL mat3x3f(<col0>, <col1>, <col2>) is column-major.
    let mv3 = mat3x3f(mv[0].xyz, mv[1].xyz, mv[2].xyz);
    let vN  = normalize(mv3 * in.normal);
    let vT  = normalize(mv3 * in.tangent.xyz);

    var out: VsOut;
    out.clip        = clipPos;
    out.uvl         = in.uvl;
    out.viewNormal  = vN;
    out.viewTangent = vec4f(vT, in.tangent.w);
    out.lightmap    = in.lightmap;
    return out;
}

// ── Atlas UV helper ───────────────────────────────────────────────────────────

const ATLAS_TILES_F: f32 = 12.0;

fn atlasUV(localUV: vec2f, tileIdx: f32) -> vec2f {
    return vec2f(
        (tileIdx + fract(localUV.x)) / ATLAS_TILES_F,
        fract(localUV.y),
    );
}

// ── GBuffer fragment outputs ──────────────────────────────────────────────────

struct GBufOut {
    @location(0) albedoRoughness: vec4f,  // rgb=albedo,  a=perceptual roughness
    @location(1) normalMetallic:  vec4f,  // rgb=viewN encoded [0,1], a=F0
    @location(2) emissiveAO:      vec4f,  // rgb=emissive (HDR), a=bakedAO (dirLight × materialAO)
    @location(3) lightmap:        vec4f,  // r=skyLight/15, g=blockLight/15, ba=unused
}

@fragment fn fs_main(in: VsOut) -> GBufOut {
    let uv = atlasUV(in.uvl.xy, in.uvl.z);

    // ── Albedo sample ─────────────────────────────────────────────────────
    let albedo = textureSample(albedoAtlas, atlasSamp, uv);
    if (albedo.a < 0.5) { discard; }

    // ── labPBR _n decode ─────────────────────────────────────────────────
    // R,G: tangent-space normal XY encoded in [0,1].  B: AO (1=bright).
    let ns  = textureSample(normalAtlas, atlasSamp, uv);
    let nx  = ns.r * 2.0 - 1.0;
    let ny  = ns.g * 2.0 - 1.0;
    let nz  = sqrt(max(0.0, 1.0 - nx * nx - ny * ny));
    let ao  = ns.b;
    let tN  = normalize(vec3f(nx, ny, nz));  // tangent-space normal

    // ── Build TBN in view space ───────────────────────────────────────────
    let N  = normalize(in.viewNormal);
    let T  = normalize(in.viewTangent.xyz);
    // B = bitangentSign * cross(N, T)
    let B  = in.viewTangent.w * cross(N, T);
    // Transform tangent-space normal to view space.
    let vN = normalize(T * tN.x + B * tN.y + N * tN.z);

    // ── labPBR _s decode ─────────────────────────────────────────────────
    // R: smoothness → roughness.  G: F0 (dielectric) or metal index.  A: emissive.
    let ss        = textureSample(specularAtlas, atlasSamp, uv);
    let roughness = 1.0 - ss.r;

    // G ≥ 229/255 ≈ 0.898 → metal flag (use 1.0 as sentinel for deferred pass)
    var f0: f32;
    if (ss.g >= 0.898) {
        f0 = 1.0;                    // metal: full reflectance, colour from albedo
    } else {
        f0 = ss.g * 0.2 + 0.02;     // dielectric: maps to ~[0.02, 0.28]
    }

    // A: emissive brightness, tinted by albedo colour.
    let emissive = ss.a * albedo.rgb;

    // Combine per-face directional shading (bakedLight, uvl.w: 0.5 bottom / 0.7-0.8 sides / 1.0 top)
    // with material AO from the normal atlas. The deferred pass reads this as a combined
    // sky-light modulator: dark undersides + occluded texels stay dark, lit tops stay bright.
    let bakedAO = in.uvl.w * ao;

    var out: GBufOut;
    out.albedoRoughness = vec4f(albedo.rgb, roughness);
    out.normalMetallic  = vec4f(vN * 0.5 + 0.5, f0);  // encode normal to [0,1]
    out.emissiveAO      = vec4f(emissive, bakedAO);
    out.lightmap        = vec4f(in.lightmap.x, in.lightmap.y, 0.0, 1.0);
    return out;
}
