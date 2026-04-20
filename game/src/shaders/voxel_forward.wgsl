// Voxel forward-rendering shader (v2).
//
// Lighting model:
//   sky_light  — BFS-propagated sky occlusion (0=cave, 1=open)
//   block_light — BFS-propagated emission (torches, etc.)
//
// Final brightness = max(sky_light * sky_factor, block_light)
// where sky_factor = ambient_sky + sun_direct.
// A tiny minimum prevents fully-black caves.
// face_light (baked at mesh time) provides directional shading.

struct FrameUniforms {
    view_proj: mat4x4<f32>,
    sun_dir: vec3<f32>,
    _pad: f32,
};

struct ChunkUniforms {
    model: mat4x4<f32>,
};

@group(0) @binding(0)
var<uniform> frame: FrameUniforms;

@group(1) @binding(0)
var<uniform> chunk: ChunkUniforms;

struct VsIn {
    @location(0) pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uvl: vec4<f32>,
    /// [skyLight/15, blockLight/15] from BFS propagation
    @location(3) light: vec2<f32>,
};

struct VsOut {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) world_normal: vec3<f32>,
    /// Per-face directional darkening (baked at mesh time).
    @location(1) face_light: f32,
    /// BFS sky light [0,1]: 1 = fully lit by sky.
    @location(2) sky_light: f32,
    /// BFS block light [0,1]: 1 = maximum emission.
    @location(3) block_light: f32,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
    let world_pos = chunk.model * vec4(in.pos, 1.0);
    var out: VsOut;
    out.clip_pos = frame.view_proj * world_pos;
    out.world_normal = in.normal;
    out.face_light = in.uvl.w;
    out.sky_light = in.light.x;
    out.block_light = in.light.y;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let n = normalize(in.world_normal);

    // Simple block colouring derived from face normal.
    var base: vec3<f32>;
    if (n.y > 0.5) {
        base = vec3(0.30, 0.72, 0.22);   // grass top
    } else if (n.y < -0.5) {
        base = vec3(0.42, 0.32, 0.22);   // bottom
    } else {
        base = vec3(0.52, 0.42, 0.30);   // sides
    }

    // ── Lighting ────────────────────────────────────
    // Sun: lambertian term (0 when facing away).
    let sun_dot = max(dot(n, frame.sun_dir), 0.0);

    // Sky light factor: ambient sky + direct sun.
    // Minimum 0.15 so shaded sky-lit surfaces aren't
    // completely dark.
    let sky_factor = 0.15 + sun_dot * 0.85;

    // Sky contribution — attenuated inside caves.
    let sky_contrib  = in.sky_light * sky_factor;

    // Block-light contribution (torches etc.) — not
    // affected by the sun direction.
    let block_contrib = in.block_light * 0.9;

    // Pick whichever source is brighter, then add a
    // tiny minimum (0.02) so fully enclosed caves are
    // dark but not pitch black.
    let light_level =
        max(sky_contrib, block_contrib) + 0.02;

    // Apply per-face directional darkening.
    let lit = base * light_level * in.face_light;

    return vec4(lit, 1.0);
}
