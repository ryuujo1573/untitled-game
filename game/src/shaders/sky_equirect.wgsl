// ── Equirectangular skybox ────────────────────────────
//
// Full-screen triangle rendered before any geometry.
// No depth attachment — the geometry pass overdraw this naturally.
//
// Group 0 binding 0 : FrameUniforms (same buffer as voxel pass)
// Group 1 binding 0 : equirect texture  (texture_2d<f32>)
// Group 1 binding 1 : sampler           (sampler, filtering)

struct FrameUniforms {
    view_proj : mat4x4<f32>,   // col-major, offset 0
    sun_dir   : vec3<f32>,     // offset 64
    _pad      : f32,           // offset 76
    view      : mat4x4<f32>,   // offset 80
    proj      : mat4x4<f32>,   // offset 144
}

@group(0) @binding(0) var<uniform> frame    : FrameUniforms;
@group(1) @binding(0) var          sky_tex  : texture_2d<f32>;
@group(1) @binding(1) var          sky_samp : sampler;

// ── Vertex: one large triangle covering NDC ───────────

struct VsOut {
    @builtin(position) pos : vec4<f32>,
    @location(0) ndc       : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -3.0),
        vec2<f32>( 3.0,  1.0),
        vec2<f32>(-1.0,  1.0),
    );
    let p = positions[vi];
    var o: VsOut;
    o.pos = vec4<f32>(p, 0.0, 1.0);
    o.ndc = p;
    return o;
}

// ── Fragment: equirectangular lookup ──────────────────

const TAU : f32 = 6.283185307;
const PI  : f32 = 3.141592654;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Reconstruct camera-space ray direction from NDC.
    // proj[0][0] = cot(half-fov-x),  proj[1][1] = cot(half-fov-y).
    let cam_dir = normalize(vec3<f32>(
         in.ndc.x / frame.proj[0][0],
         in.ndc.y / frame.proj[1][1],
        -1.0,
    ));

    // Rotate cam_dir from camera space to world space.
    // view is world→camera; cam→world is R^T.
    // In WGSL column-major (v[col][row]):  cam_dir * R  ==  R^T * cam_dir.
    let v = frame.view;
    let rot = mat3x3<f32>(v[0].xyz, v[1].xyz, v[2].xyz);
    let world_dir = normalize(cam_dir * rot);

    // Equirectangular mapping.
    // phi   ∈ [-π, π]      → u ∈ [0, 1]  (yaw,   +X at phi = 0)
    // theta ∈ [-π/2, π/2]  → v ∈ [0, 1]  (pitch, +Y at top)
    let phi       = atan2(world_dir.z, world_dir.x);
    let theta     = asin(clamp(world_dir.y, -1.0, 1.0));
    let u         = phi   / TAU + 0.5;
    let v_coord   = 0.5  - theta / PI;

    return textureSample(sky_tex, sky_samp, vec2<f32>(u, v_coord));
}
