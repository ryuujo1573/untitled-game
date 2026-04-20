// ── Deferred lighting resolve ─────────────────────────
//
// Full-screen triangle.  Reads G-buffer + CSM shadow atlas.
// Writes to the HDR colour buffer (Rgba16Float).
//
// Group 0: FrameUBO + CascadeUBO (bindings 0, 1)
// Group 1: G-buffer textures + depth + shadow + samplers
//   0: gbuf_albedo   (texture_2d<f32>)
//   1: gbuf_normal   (texture_2d<f32>)
//   2: gbuf_emission (texture_2d<f32>)
//   3: gbuf_motion   (texture_2d<f32>)
//   4: depth         (texture_depth_2d)
//   5: shadow_csm    (texture_depth_2d_array)
//   6: tex_sampler   (sampler, non-comparison)
//   7: shadow_sampler(sampler_comparison)

struct FrameUBO {
    view_proj      : mat4x4<f32>,
    prev_view_proj : mat4x4<f32>,
    view           : mat4x4<f32>,
    proj           : mat4x4<f32>,
    cam_pos        : vec3<f32>,
    time           : f32,
    sun_dir        : vec3<f32>,
    sun_intensity  : f32,
    screen_size    : vec2<f32>,
    near_z         : f32,
    far_z          : f32,
}

struct CascadeUBO {
    view_proj : array<mat4x4<f32>, 4>,
    splits    : vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame   : FrameUBO;
@group(0) @binding(1) var<uniform> cascade : CascadeUBO;

@group(1) @binding(0) var gbuf_albedo    : texture_2d<f32>;
@group(1) @binding(1) var gbuf_normal    : texture_2d<f32>;
@group(1) @binding(2) var gbuf_emission  : texture_2d<f32>;
@group(1) @binding(3) var gbuf_motion    : texture_2d<f32>;
@group(1) @binding(4) var depth_tex      : texture_depth_2d;
@group(1) @binding(5) var shadow_csm     : texture_depth_2d_array;
@group(1) @binding(6) var tex_sampler    : sampler;
@group(1) @binding(7) var shadow_sampler : sampler_comparison;

// ── Full-screen triangle ───────────────────────────────

struct FsIn {
    @builtin(position) frag_coord : vec4<f32>,
    @location(0) uv : vec2<f32>,
}

@vertex
fn vs_fullscreen(
    @builtin(vertex_index) vi : u32,
) -> FsIn {
    // Three-vertex NDC triangle covering the full clip space.
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -3.0),
        vec2<f32>( 3.0,  1.0),
        vec2<f32>(-1.0,  1.0),
    );
    var uv = array<vec2<f32>, 3>(
        vec2<f32>(0.0,  2.0),
        vec2<f32>(2.0,  0.0),
        vec2<f32>(0.0,  0.0),
    );
    var o: FsIn;
    o.frag_coord = vec4<f32>(pos[vi], 0.0, 1.0);
    o.uv         = uv[vi];
    return o;
}

// ── Helpers ───────────────────────────────────────────

fn oct_decode(oct: vec2<f32>) -> vec3<f32> {
    let n = oct * 2.0 - 1.0;
    var r = vec3<f32>(n.x, n.y, 1.0 - abs(n.x) - abs(n.y));
    let t = max(-r.z, 0.0);
    r.x -= select(-t, t, r.x >= 0.0);
    r.y -= select(-t, t, r.y >= 0.0);
    return normalize(r);
}

fn linear_depth(d: f32) -> f32 {
    let n = frame.near_z;
    let f = frame.far_z;
    return n * f / (f - d * (f - n));
}

fn shadow_factor(
    world_pos : vec3<f32>,
    lin_depth : f32,
) -> f32 {
    // Choose cascade based on linear view-space depth.
    var layer = 3u;
    if lin_depth < cascade.splits.x { layer = 0u; }
    else if lin_depth < cascade.splits.y { layer = 1u; }
    else if lin_depth < cascade.splits.z { layer = 2u; }

    let lspos = cascade.view_proj[layer] * vec4<f32>(world_pos, 1.0);
    let proj  = lspos.xyz / lspos.w;
    let uv    = proj.xy * 0.5 + 0.5;
    if uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 {
        return 1.0;
    }
    // PCF 2×2
    let bias  = 0.0005;
    let ref_d = proj.z - bias;
    let s = textureSampleCompare(
        shadow_csm, shadow_sampler, uv, i32(layer), ref_d);
    return s;
}

fn world_pos_from_depth(
    uv       : vec2<f32>,
    depth    : f32,
) -> vec3<f32> {
    let ndc = vec4<f32>(uv * 2.0 - 1.0, depth, 1.0);
    // Reconstruct via inverse view-proj (approx: use stored matrices).
    // For now, simplified position for lighting calc.
    // TODO: pass inverse matrices in FrameUBO.
    let view_pos = ndc * vec4<f32>(
        1.0 / frame.proj[0][0],
        1.0 / frame.proj[1][1],
        -1.0,
        0.0,
    );
    let view4 = vec4<f32>(view_pos.x * ndc.z,
                           view_pos.y * ndc.z,
                           linear_depth(depth),
                           1.0);
    // Transform back to world space via inverse view.
    // Approximate: transpose of upper-left 3x3 for orthonormal view.
    let v = frame.view;
    let world = vec3<f32>(
        v[0][0]*view4.x + v[1][0]*view4.y + v[2][0]*view4.z + v[3][0],
        v[0][1]*view4.x + v[1][1]*view4.y + v[2][1]*view4.z + v[3][1],
        v[0][2]*view4.x + v[1][2]*view4.y + v[2][2]*view4.z + v[3][2],
    );
    return world;
}

// ── Lighting ───────────────────────────────────────────

const PI : f32 = 3.14159265;
const INV_PI : f32 = 0.31830988;

fn ggx_ndf(ndoth: f32, roughness: f32) -> f32 {
    let a  = roughness * roughness;
    let a2 = a * a;
    let d  = ndoth * ndoth * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

fn schlick_fresnel(f0: vec3<f32>, vdoth: f32) -> vec3<f32> {
    return f0 + (1.0 - f0) * pow(1.0 - vdoth, 5.0);
}

fn smith_ggx_v(ndotl: f32, ndotv: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = r * r / 8.0;
    let gl = ndotl / (ndotl * (1.0 - k) + k);
    let gv = ndotv / (ndotv * (1.0 - k) + k);
    return gl * gv;
}

@fragment
fn fs_main(in: FsIn) -> @location(0) vec4<f32> {
    let coord = vec2<i32>(in.frag_coord.xy);

    let albedo_s   = textureLoad(gbuf_albedo,   coord, 0);
    let normal_s   = textureLoad(gbuf_normal,   coord, 0);
    let emission_s = textureLoad(gbuf_emission, coord, 0);
    let motion_s   = textureLoad(gbuf_motion,   coord, 0);
    let depth      = textureLoad(depth_tex,     coord, 0);

    // Early-out for skybox / empty pixels.
    if depth >= 1.0 { return vec4<f32>(0.0); }

    let albedo    = albedo_s.rgb;
    let normal    = oct_decode(normal_s.rg);
    let roughness = normal_s.b;
    let metallic  = normal_s.a;
    let emission  = emission_s.rgb;
    let ao        = emission_s.a;
    let block_l   = motion_s.b;
    let sky_l     = motion_s.a;

    let uv       = in.uv;
    let lin_dep  = linear_depth(depth);
    let wpos     = world_pos_from_depth(uv, depth);
    let view_dir = normalize(frame.cam_pos - wpos);

    let sun = normalize(frame.sun_dir);
    let ndotl = max(dot(normal, sun), 0.0);

    // Shadow
    let shadow = shadow_factor(wpos, lin_dep);

    // PBR: Cook-Torrance specular + Lambertian diffuse.
    let f0      = mix(vec3<f32>(0.04), albedo, metallic);
    let h       = normalize(sun + view_dir);
    let ndoth   = max(dot(normal, h), 0.0);
    let ndotv   = max(dot(normal, view_dir), 0.0);
    let vdoth   = max(dot(view_dir, h), 0.0);

    let D = ggx_ndf(ndoth, roughness);
    let F = schlick_fresnel(f0, vdoth);
    let V = smith_ggx_v(ndotl, ndotv, roughness);

    let specular = (D * V * F) / max(4.0 * ndotl * ndotv, 0.0001);
    let ks       = F;
    let kd       = (1.0 - ks) * (1.0 - metallic);
    let diffuse  = kd * albedo * INV_PI;

    let direct = (diffuse + specular)
        * frame.sun_intensity
        * ndotl
        * shadow;

    // Block + sky ambient (from G-buffer).
    let block_colour = vec3<f32>(1.0, 0.8, 0.5) * block_l;
    let sky_colour   = vec3<f32>(0.5, 0.7, 1.0) * sky_l;
    let ambient      = (block_colour + sky_colour) * albedo * ao;

    let hdr = direct + ambient + emission;
    return vec4<f32>(hdr, 1.0);
}
