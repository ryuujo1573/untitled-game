// ── LUT Blit ─────────────────────────────────────────────────────────────────
//
// Full-screen triangle that samples the intermediate scene texture and maps
// each pixel through a 32×32×32 3-D colour-grading LUT.
//
// Group 0
//   binding 0 : scene_tex  — texture_2d<f32>  (Rgba8Unorm intermediate RT)
//   binding 1 : lut_tex    — texture_3d<f32>  (Rgba8Unorm 32³ LUT)
//   binding 2 : samp       — sampler (linear, clamp-to-edge)

@group(0) @binding(0) var scene_tex : texture_2d<f32>;
@group(0) @binding(1) var lut_tex   : texture_3d<f32>;
@group(0) @binding(2) var samp      : sampler;

// ── Vertex ────────────────────────────────────────────

struct VsOut {
    @builtin(position) pos : vec4<f32>,
    @location(0)       uv  : vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
    // One large triangle that covers the entire clip space.
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -3.0),
        vec2<f32>( 3.0,  1.0),
        vec2<f32>(-1.0,  1.0),
    );
    let p = positions[vi];
    var o: VsOut;
    o.pos = vec4<f32>(p, 0.0, 1.0);
    // NDC (-1..1) → UV (0..1), flip Y (NDC +Y = up, UV +Y = down).
    o.uv  = p * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
    return o;
}

// ── Fragment ──────────────────────────────────────────

// LUT is 32×32×32.  Scale + offset to sample at texel centres so the
// hardware trilinear filter interpolates correctly.
const LUT_N      : f32 = 32.0;
const LUT_SCALE  : f32 = 31.0 / 32.0;   // (N-1)/N
const LUT_OFFSET : f32 =  0.5 / 32.0;   // 0.5/N

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let color = textureSample(scene_tex, samp, in.uv);
    let coord = color.rgb * LUT_SCALE + LUT_OFFSET;
    let graded = textureSample(lut_tex, samp, coord);
    return vec4<f32>(graded.rgb, 1.0);
}
