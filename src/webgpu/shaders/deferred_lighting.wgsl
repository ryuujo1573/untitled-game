// =============================================================================
// deferred_lighting.wgsl
//
// PTGI-inspired deferred lighting pass.
//
// Lighting model (SEUS PTGI-flavoured, adapted for WebGPU deferred pipeline):
//
//   ambient  = skyHemisphere(worldN) × skyLight × bakedAO × albedo
//              ┗━ hemisphere blend: sky color (up) ↔ warm ground bounce (down)
//              ┗━ skyLight = per-vertex propagated sky light (0-15/15, from gbuf3.r)
//              ┗━ bakedAO  = face directional shading × material AO (from GBuf)
//
//   direct   = cookTorranceBRDF(L,V,N) × nDotL × sunStr × skyLight
//              ┗━ zero in enclosed spaces (skyLight = 0)
//
//   blockLit = blockLight × warmColor × albedo
//              ┗━ warm amber glow from emissive blocks (RedstoneOre, etc.)
//              ┗━ blockLight = BFS-propagated torch light (0-15/15, from gbuf3.g)
//              ┗━ ALWAYS present – works in pitch-black caves
//
//   emissive = block-light / self-emission term from specular atlas
//              ┗━ legacy path; most blocks have emission=0
//
//   sky      = zenith-horizon gradient + equirect skybox + procedural sun disk
//
// GBuffer layout (from gbuffers_terrain.wgsl):
//   colortex0  rgba8unorm   rgb = albedo,           a = roughness
//   colortex1  rgba16float  rgb = viewNormal[0,1],  a = F0
//   colortex2  rgba8unorm   rgb = emissive,         a = bakedAO
//   colortex3  rgba8unorm   r = skyLight/15,        g = blockLight/15
//   depthTex   depth_2d
//
// Bind group 0:
//   0 — GFrameUniforms UBO
//   1 — colortex0  (texture_2d<f32>)
//   2 — colortex1  (texture_2d<f32>)
//   3 — colortex2  (texture_2d<f32>)
//   4 — depthTex   (texture_depth_2d)
//   5 — skyboxTex  (rgba8unorm equirect)
//   6 — skyboxSamp (linear sampler, repeat-U / clamp-V)
//   7 — colortex3  (texture_2d<f32>) — lightmap
// =============================================================================

struct GFrameUniforms {
    view:           mat4x4f,   // bytes   0–63
    projection:     mat4x4f,   // bytes  64–127
    viewInv:        mat4x4f,   // bytes 128–191
    projInv:        mat4x4f,   // bytes 192–255
    sunDirStrength: vec4f,     // bytes 256–271  xyz=sunDir(view-space), w=strength
    sunColor:       vec4f,     // bytes 272–287  xyz=color, w=unused
    ambientColor:   vec4f,     // bytes 288–303  xyz=skyColor, w=scale
    fogColorNear:   vec4f,     // bytes 304–319  xyz=fogColor, w=fogNear
    fogFar:         vec4f,     // bytes 320–335  x=fogFar
}

@group(0) @binding(0) var<uniform> frame:     GFrameUniforms;
@group(0) @binding(1) var          gbuf0:     texture_2d<f32>;
@group(0) @binding(2) var          gbuf1:     texture_2d<f32>;
@group(0) @binding(3) var          gbuf2:     texture_2d<f32>;
@group(0) @binding(4) var          depthTex:  texture_depth_2d;
@group(0) @binding(5) var          skyboxTex: texture_2d<f32>;
@group(0) @binding(6) var          skyboxSamp: sampler;
@group(0) @binding(7) var          gbuf3:     texture_2d<f32>;  // lightmap: r=sky, g=block

// ── Constants ─────────────────────────────────────────────────────────────────
const PI:     f32 = 3.14159265358979;
const TWO_PI: f32 = 6.28318530717959;

// ── Fullscreen triangle vertex ─────────────────────────────────────────────────
struct VsOut {
    @builtin(position) clip: vec4f,
    @location(0)       uv:   vec2f,
}

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
    let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
    let y = f32( vi         & 2u) * 2.0 - 1.0;
    var out: VsOut;
    out.clip = vec4f(x, y, 0.0, 1.0);
    out.uv   = vec2f(x * 0.5 + 0.5, -y * 0.5 + 0.5);
    return out;
}

// ── Cook-Torrance BRDF ─────────────────────────────────────────────────────────

fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {
    let a  = roughness * roughness;
    let a2 = a * a;
    let d  = nDotH * nDotH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d + 0.0001);
}

fn geometrySchlickGGX(nDotX: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return nDotX / (nDotX * (1.0 - k) + k + 0.0001);
}

fn fresnelSchlick(cosTheta: f32, f0: f32) -> f32 {
    return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// ── Sky helpers ────────────────────────────────────────────────────────────────

// Reconstruct world-space ray direction from NDC xy and the inverse matrices.
fn worldRayFromNdc(ndcXY: vec2f) -> vec3f {
    let clipFar = vec4f(ndcXY, 1.0, 1.0);
    let vRay4   = frame.projInv * clipFar;
    let vRay    = normalize(vRay4.xyz / max(vRay4.w, 0.0001));
    return normalize((frame.viewInv * vec4f(vRay, 0.0)).xyz);
}

// Equirectangular UV from world-space direction.
fn equirectUV(dir: vec3f) -> vec2f {
    let u = atan2(dir.z, dir.x) / TWO_PI + 0.5;
    let v = acos(clamp(dir.y, -1.0, 1.0)) / PI;
    return vec2f(fract(u), clamp(v, 0.0, 1.0));
}

// PTGI-style sky: horizon-zenith gradient blended with equirect skybox + sun disk.
fn evalSky(wRay: vec3f) -> vec3f {
    let skyAmb  = frame.ambientColor.rgb * frame.ambientColor.w;
    let horizon = frame.fogColorNear.rgb;

    // Gradient: horizon colour at wRay.y=0 → sky zenith colour at wRay.y=1.
    // Use a soft exponent (0.35) so the horizon band is wide, like PTGI.
    let gradT    = pow(max(0.0, wRay.y), 0.35);
    let gradient = mix(horizon, skyAmb * 1.4, gradT);

    // Equirect skybox (blended 50/50 with the procedural gradient).
    let skybox = textureSample(skyboxTex, skyboxSamp, equirectUV(wRay)).rgb;
    let skyBase = mix(gradient, skybox, 0.5);

    // Procedural sun disk & corona glow.
    let sunViewDir = normalize(frame.sunDirStrength.xyz);
    let wSunDir    = normalize((frame.viewInv * vec4f(sunViewDir, 0.0)).xyz);
    let sunDot     = dot(wRay, wSunDir);
    let sunStr     = frame.sunDirStrength.w;
    let disk       = smoothstep(0.9996, 0.9999, sunDot) * sunStr * 10.0;
    let corona     = smoothstep(0.990,  0.9996, sunDot) * sunStr * 0.5;

    return skyBase + frame.sunColor.rgb * (disk + corona);
}

// ── Fragment ───────────────────────────────────────────────────────────────────

@fragment fn fs_main(in: VsOut) -> @location(0) vec4f {
    let sc = vec2i(i32(in.clip.x), i32(in.clip.y));

    // ── Depth / sky early-out ─────────────────────────────────────────
    let depth  = textureLoad(depthTex, sc, 0);
    let ndcXY  = vec2f(in.uv.x * 2.0 - 1.0, -(in.uv.y * 2.0 - 1.0));
    if (depth >= 0.9999) {
        return vec4f(evalSky(worldRayFromNdc(ndcXY)), 1.0);
    }

    // ── GBuffer reads ─────────────────────────────────────────────────
    let s0 = textureLoad(gbuf0, sc, 0);
    let s1 = textureLoad(gbuf1, sc, 0);
    let s2 = textureLoad(gbuf2, sc, 0);
    let s3 = textureLoad(gbuf3, sc, 0);

    let albedo    = s0.rgb;
    let roughness = max(s0.a, 0.04);
    let viewN     = normalize(s1.rgb * 2.0 - 1.0);
    let f0        = s1.a;
    let emissive  = s2.rgb;
    let bakedAO   = s2.a;   // per-face directional shading × material AO

    // ── Per-pixel light levels (from voxel BFS light propagation) ─────
    // skyLight:   0.0 = fully enclosed underground, 1.0 = open sky
    // blockLight: 0.0 = no nearby emissive block,   1.0 = adjacent to strong source
    let skyLight   = s3.r;  // normalised sky light  (0-1)
    let blockLight = s3.g;  // normalised block light (0-1)

    // ── Reconstruct view-space position ───────────────────────────────
    let clipPos = vec4f(ndcXY, depth, 1.0);
    let vPos4   = frame.projInv * clipPos;
    let viewPos = vPos4.xyz / vPos4.w;

    // ── Lighting vectors ──────────────────────────────────────────────
    let L     = normalize(frame.sunDirStrength.xyz);
    let V     = normalize(-viewPos);
    let H     = normalize(L + V);
    let N     = viewN;
    let nDotL = max(dot(N, L), 0.0);
    let nDotV = max(dot(N, V), 0.001);
    let nDotH = max(dot(N, H), 0.0);
    let vDotH = max(dot(V, H), 0.0);

    // ── Cook-Torrance specular ────────────────────────────────────────
    let D        = distributionGGX(nDotH, roughness);
    let G        = geometrySchlickGGX(nDotV, roughness) *
                   geometrySchlickGGX(nDotL, roughness);
    let F        = fresnelSchlick(vDotH, f0);
    let specBRDF = (D * G * F) / (4.0 * nDotV * nDotL + 0.0001);

    let isMetal  = select(0.0, 1.0, f0 >= 0.9);
    let kD       = (1.0 - F) * (1.0 - isMetal);
    let diffBRDF = kD * albedo / PI;

    // ── Direct sunlight (gated by sky light — zero deep underground) ──
    let direct = (diffBRDF + specBRDF) * nDotL *
                 frame.sunDirStrength.w * frame.sunColor.rgb * skyLight;

    // ── PTGI hemisphere ambient ───────────────────────────────────────
    // World-space normal → hemisphere blend factor (0=down-facing, 1=up-facing).
    let worldN  = normalize((frame.viewInv * vec4f(viewN, 0.0)).xyz);
    let upDot   = worldN.y * 0.5 + 0.5; // [0, 1]

    // Sky (cool blue) blending to warm ground bounce (~15% of sky, warm tint).
    let skyAmb = frame.ambientColor.rgb * frame.ambientColor.w;
    let gndAmb = skyAmb * vec3f(1.05, 0.65, 0.40) * 0.15;  // warm ochre bounce
    let hemisAmb = mix(gndAmb, skyAmb, upDot);

    // Scale by sky light (BFS-propagated: 0 underground, 1 open sky) + baked AO.
    let ambient = hemisAmb * albedo * bakedAO * skyLight;

    // ── Block light (torch / emissive block glow) ─────────────────────
    // Warm amber colour, always present even in pitch-black caves.
    // Intensity = blockLight (0-1), carrying the fall-off from the BFS.
    let warmColor = vec3f(1.0, 0.58, 0.20);   // amber torch tint
    let blockLit  = blockLight * 2.0 * warmColor * albedo;

    // ── Fog ───────────────────────────────────────────────────────────
    let dist = length(viewPos);
    let fogT = clamp((dist - frame.fogColorNear.w) /
                     (frame.fogFar.x - frame.fogColorNear.w), 0.0, 1.0);

    // ── Compose HDR ───────────────────────────────────────────────────
    // emissive (specular-atlas self-emission) is always present — legacy path.
    // blockLit (BFS block light) provides warm glow near emissive blocks.
    var hdr = direct + ambient + emissive + blockLit;
    hdr = mix(hdr, frame.fogColorNear.rgb, fogT);

    return vec4f(hdr, 1.0);
}
