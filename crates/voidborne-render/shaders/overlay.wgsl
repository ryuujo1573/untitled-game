// ── Overlay shaders: block-outline (3-D) + crosshair (2-D) ──────────
//
// These are compiled together but use separate entry points so one
// module serves both pipelines.

// ── Shared frame UBO (only view_proj needed here) ────────────────────

struct FrameUBO {
    view_proj:      mat4x4<f32>,
    prev_view_proj: mat4x4<f32>,
    view:           mat4x4<f32>,
    proj:           mat4x4<f32>,
    cam_pos:        vec3<f32>,
    time:           f32,
    sun_dir:        vec3<f32>,
    sun_intensity:  f32,
    screen_size:    vec2<f32>,
    near_z:         f32,
    far_z:          f32,
};

@group(0) @binding(0)
var<uniform> frame: FrameUBO;

// ── Block outline (LineList, uses depth test) ─────────────────────────

struct OutlineVert {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn outline_vs(@location(0) pos: vec3<f32>) -> OutlineVert {
    let clip = frame.view_proj * vec4<f32>(pos, 1.0);
    // Push slightly toward camera to avoid z-fighting with the block face.
    var out: OutlineVert;
    out.pos = vec4<f32>(clip.xy, clip.z - 0.001 * clip.w, clip.w);
    return out;
}

@fragment
fn outline_fs(in: OutlineVert) -> @location(0) vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}

// ── Crosshair (TriangleList, 2-D, no depth) ───────────────────────────

struct CrosshairVert {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn crosshair_vs(@location(0) pos: vec2<f32>) -> CrosshairVert {
    return CrosshairVert(vec4<f32>(pos, 0.0, 1.0));
}

@fragment
fn crosshair_fs(in: CrosshairVert) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, 0.9);
}
