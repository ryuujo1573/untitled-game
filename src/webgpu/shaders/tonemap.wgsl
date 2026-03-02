// ─── HDR tonemapping post-process shader ─────────────────────────────────────
//
// Full-screen blit that applies ACES filmic tonemapping and gamma 2.2 encode.
// Draws a single oversized triangle via vertex_index (no VBO needed).
//
// Bind groups:
//   @group(0) @binding(0) – HDR colour texture  (rgba16float)
//   @group(0) @binding(1) – texture sampler      (LINEAR, CLAMP)
//   @group(0) @binding(2) – TonemapUniforms      (exposure)

struct TonemapUniforms {
    exposure: f32,
    _p0: f32,   // pad to 16 bytes
    _p1: f32,
    _p2: f32,
}

@group(0) @binding(0) var hdrBuffer:  texture_2d<f32>;
@group(0) @binding(1) var hdrSampler: sampler;
@group(0) @binding(2) var<uniform> params: TonemapUniforms;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0)       uv:  vec2f,
}

// One triangle that covers NDC [-1, 1]² in clip space.
// vertex 0 → (-1, -1),  vertex 1 → (3, -1),  vertex 2 → (-1, 3)
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
    var out: VsOut;
    let x = select(-1.0, 3.0, vi == 1u);
    let y = select(-1.0, 3.0, vi == 2u);
    out.pos = vec4f(x, y, 0.0, 1.0);
    // Map NDC → UV, flip Y so texture top-left == screen top-left.
    out.uv  = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
    return out;
}

// Narkowicz 2015 ACES filmic approximation.
fn aces(x: vec3f) -> vec3f {
    let a: f32 = 2.51;
    let b: f32 = 0.03;
    let c: f32 = 2.43;
    let d: f32 = 0.59;
    let e: f32 = 0.14;
    return clamp(
        (x * (a * x + b)) / (x * (c * x + d) + e),
        vec3f(0.0),
        vec3f(1.0),
    );
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    let hdr = textureSample(hdrBuffer, hdrSampler, in.uv).rgb * params.exposure;
    let ldr = pow(aces(hdr), vec3f(1.0 / 2.2));
    return vec4f(ldr, 1.0);
}
