// ── Equirectangular skybox pass ───────────────────────
//
// Full-screen triangle.  Reconstructs the world-space view ray from
// NDC + FrameUBO, then samples an equirectangular (lat/long) panorama.
//
// Pixels that have geometry (depth < 1.0) are discarded so only sky
// fragments are touched.  Run this pass AFTER the deferred-lighting
// resolve so geometry pixels are already lit.
//
// Group 0 – binding 0 : FrameUBO  (same struct as other passes)
// Group 1 – binding 0 : equirect  (texture_2d<f32>)
//         – binding 1 : depth_tex (texture_depth_2d)
//         – binding 2 : sky_sampler (sampler, filtering)

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

@group(0) @binding(0) var<uniform> frame : FrameUBO;

@group(1) @binding(0) var equirect_tex : texture_2d<f32>;
@group(1) @binding(1) var depth_tex    : texture_depth_2d;
@group(1) @binding(2) var sky_sampler  : sampler;

// ── Full-screen triangle ───────────────────────────────

struct FsIn {
    @builtin(position) frag_coord : vec4<f32>,
    /// Raw NDC [-1, 1] passed through for ray reconstruction.
    @location(0) ndc              : vec2<f32>,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> FsIn {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -3.0),
        vec2<f32>( 3.0,  1.0),
        vec2<f32>(-1.0,  1.0),
    );
    var o: FsIn;
    let p    = pos[vi];
    o.frag_coord = vec4<f32>(p, 0.0, 1.0);
    o.ndc        = p;
    return o;
}

// ── Constants ─────────────────────────────────────────

const TAU : f32 = 6.283185307;
const PI  : f32 = 3.141592654;

// ── Fragment ──────────────────────────────────────────

@fragment
fn fs_main(in: FsIn) -> @location(0) vec4<f32> {
    // Skip pixels that already have geometry.
    let coord = vec2<i32>(in.frag_coord.xy);
    let d = textureLoad(depth_tex, coord, 0);
    if d < 1.0 { discard; }

    // ── Reconstruct world-space view direction ─────────
    //
    // proj[0][0] = cot(half-fov-x),  proj[1][1] = cot(half-fov-y).
    // Camera space uses a right-hand convention, looking down -Z.
    let cam_dir = normalize(vec3<f32>(
         in.ndc.x / frame.proj[0][0],
         in.ndc.y / frame.proj[1][1],
        -1.0,
    ));

    // Rotate from camera space to world space.
    // view is world→camera; cam→world is V^T.
    // In WGSL (column-major), `cam_dir * rot` (row-vec × matrix)
    // equals V^T × cam_dir, which is what we want.
    let v = frame.view;
    let rot = mat3x3<f32>(v[0].xyz, v[1].xyz, v[2].xyz);
    let world_dir = normalize(cam_dir * rot);

    // ── Equirectangular mapping ────────────────────────
    //
    // phi   ∈ [-π, π]   → u ∈ [0, 1]  (horizontal, +X = phi=0)
    // theta ∈ [-π/2, π/2] → v ∈ [0, 1]  (vertical,   +Y = top)
    let phi   = atan2(world_dir.z, world_dir.x);
    let theta = asin(clamp(world_dir.y, -1.0, 1.0));

    let u = phi / TAU + 0.5;
    let v_coord = 0.5 - theta / PI;

    let color = textureSample(equirect_tex, sky_sampler, vec2<f32>(u, v_coord));
    return vec4<f32>(color.rgb, 1.0);
}
