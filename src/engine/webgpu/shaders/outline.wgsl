// ─── Block-selection wireframe outline shader ────────────────────────────────
//
// Renders the 12 edges of a unit cube (slightly expanded by ε) as black lines
// that fade in/out via a per-draw alpha uniform.
//
// Bind groups:
//   @group(0) @binding(0) – FrameUniforms  (view, projection; same struct as voxel.wgsl)
//   @group(1) @binding(0) – OutlineUniforms (model matrix + alpha)

struct FrameUniforms {
    view:       mat4x4f,
    projection: mat4x4f,
    ambient:    vec3f,
    fogNear:    f32,
    fogColor:   vec3f,
    fogFar:     f32,
}

struct OutlineUniforms {
    model: mat4x4f, // bytes  0-63
    alpha: f32,     // byte  64
    _p0:  f32,      // padding to 80 bytes
    _p1:  f32,
    _p2:  f32,
}

@group(0) @binding(0) var<uniform> frame:   FrameUniforms;
@group(1) @binding(0) var<uniform> outline: OutlineUniforms;

@vertex
fn vs_main(@location(0) pos: vec3f) -> @builtin(position) vec4f {
    return frame.projection * frame.view * outline.model * vec4f(pos, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
    return vec4f(0.0, 0.0, 0.0, 0.75 * outline.alpha);
}
