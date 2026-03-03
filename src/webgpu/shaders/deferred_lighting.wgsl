// =============================================================================
// deferred_lighting.wgsl
//
// Deferred lighting pass — reads GBuffer textures produced by
// gbuffers_terrain.wgsl and evaluates a Cook-Torrance BRDF with a single
// directional sun light plus ambient.
//
// Emits HDR radiance into a rgba16float render target; the tonemap pass
// converts it to display colour.
//
// Bind group 0:
//   0 — GFrameUniforms UBO (336 bytes)
//   1 — colortex0  (albedoRoughness, rgba8unorm  → texture_2d<f32>)
//   2 — colortex1  (normalMetallic,  rgba16float → texture_2d<f32>)
//   3 — colortex2  (emissiveAO,      rgba8unorm  → texture_2d<f32>)
//   4 — depthTex   (texture_depth_2d)
//   5 — skyboxTex  (rgba8unorm equirect sky texture)
//   6 — skyboxSamp (linear sampler)
//
// All GBuffer reads use textureLoad (integer screen-space coords) so
// no sampler binding is required in this pass.
// =============================================================================

struct GFrameUniforms {
    view:           mat4x4f,   // bytes   0-63
    projection:     mat4x4f,   // bytes  64-127
    viewInv:        mat4x4f,   // bytes 128-191
    projInv:        mat4x4f,   // bytes 192-255
    sunDirStrength: vec4f,     // bytes 256-271  xyz=sunDir(view space), w=strength
    sunColor:       vec4f,     // bytes 272-287  xyz=color, w=unused
    ambientColor:   vec4f,     // bytes 288-303  xyz=color, w=scale
    fogColorNear:   vec4f,     // bytes 304-319  xyz=fogColor, w=fogNear
    fogFar:         vec4f,     // bytes 320-335  x=fogFar
}

@group(0) @binding(0) var<uniform> frame:    GFrameUniforms;
@group(0) @binding(1) var          gbuf0:    texture_2d<f32>;   // albedoRoughness
@group(0) @binding(2) var          gbuf1:    texture_2d<f32>;   // normalMetallic
@group(0) @binding(3) var          gbuf2:    texture_2d<f32>;   // emissiveAO
@group(0) @binding(4) var          depthTex: texture_depth_2d;
@group(0) @binding(5) var          skyboxTex: texture_2d<f32>;
@group(0) @binding(6) var          skyboxSamp: sampler;

// ---- Fullscreen-triangle vertex -------------------------------------------

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

// ---- Cook-Torrance BRDF helpers -------------------------------------------

const PI: f32 = 3.14159265358979;
const TWO_PI: f32 = 6.28318530717959;

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

// ---- Fragment ---------------------------------------------------------------

@fragment fn fs_main(in: VsOut) -> @location(0) vec4f {
    let sc = vec2i(i32(in.clip.x), i32(in.clip.y));

    let s0 = textureLoad(gbuf0, sc, 0);
    let s1 = textureLoad(gbuf1, sc, 0);
    let s2 = textureLoad(gbuf2, sc, 0);

    let albedo    = s0.rgb;
    let roughness = max(s0.a, 0.04);
    let viewN     = normalize(s1.rgb * 2.0 - 1.0);
    let f0        = s1.a;
    let emissive  = s2.rgb;
    let ao        = s2.a;

    // Reconstruct view-space position from depth (perspectiveZO: near=0, far=1)
    let depth   = textureLoad(depthTex, sc, 0);
    let ndcXY   = vec2f(in.uv.x * 2.0 - 1.0, -(in.uv.y * 2.0 - 1.0));
    let clipPos = vec4f(ndcXY, depth, 1.0);
    let vPos4   = frame.projInv * clipPos;
    let viewPos = vPos4.xyz / vPos4.w;

    // Sky pixels have depth ~1 — no geometry was rasterised here.
    if (depth >= 0.9999) {
        let clipFar = vec4f(ndcXY, 1.0, 1.0);
        let vRay4   = frame.projInv * clipFar;
        let vRay    = normalize(vRay4.xyz / max(vRay4.w, 0.0001));
        let wRay    = normalize((frame.viewInv * vec4f(vRay, 0.0)).xyz);

        let skyU = atan2(wRay.z, wRay.x) / TWO_PI + 0.5;
        let skyV = acos(clamp(wRay.y, -1.0, 1.0)) / PI;
        let sky  = textureSample(skyboxTex, skyboxSamp, vec2f(fract(skyU), clamp(skyV, 0.0, 1.0)));
        return vec4f(sky.rgb, 1.0);
    }

    let L     = normalize(frame.sunDirStrength.xyz);
    let V     = normalize(-viewPos);
    let H     = normalize(L + V);
    let N     = viewN;
    let nDotL = max(dot(N, L), 0.0);
    let nDotV = max(dot(N, V), 0.001);
    let nDotH = max(dot(N, H), 0.0);
    let vDotH = max(dot(V, H), 0.0);

    let D        = distributionGGX(nDotH, roughness);
    let G        = geometrySchlickGGX(nDotV, roughness) *
                   geometrySchlickGGX(nDotL, roughness);
    let F        = fresnelSchlick(vDotH, f0);
    let specBRDF = (D * G * F) / (4.0 * nDotV * nDotL + 0.0001);

    let isMetal  = select(0.0, 1.0, f0 >= 0.9);
    let kD       = (1.0 - F) * (1.0 - isMetal);
    let diffBRDF = kD * albedo / PI;

    let direct = (diffBRDF + specBRDF) * nDotL *
                 frame.sunDirStrength.w * frame.sunColor.rgb;

    let ambient = frame.ambientColor.rgb * frame.ambientColor.w * albedo * ao;

    let dist    = length(viewPos);
    let fogT    = clamp((dist - frame.fogColorNear.w) /
                        (frame.fogFar.x - frame.fogColorNear.w), 0.0, 1.0);

    var hdr = direct + ambient + emissive;
    hdr = mix(hdr, frame.fogColorNear.rgb, fogT);

    return vec4f(hdr, 1.0);
}
