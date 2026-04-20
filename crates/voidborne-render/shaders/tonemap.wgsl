// ── Tonemap + TAA resolve ─────────────────────────────
//
// Full-screen triangle.  Reads HDR buffer + history for TAA.
// Writes to the sRGB swapchain surface.
//
// Group 0:
//   0: hdr_tex      (texture_2d<f32>)
//   1: history_tex  (texture_2d<f32>)
//   2: motion_tex   (texture_2d<f32>)
//   3: tex_sampler  (sampler)
//
// Group 1:
//   0: PostUBO (uniforms: exposure, bloom_strength, taa_blend)

struct PostUBO {
    exposure      : f32,
    bloom_strength: f32,
    taa_blend     : f32,
    _pad          : f32,
}

@group(0) @binding(0) var hdr_tex     : texture_2d<f32>;
@group(0) @binding(1) var history_tex : texture_2d<f32>;
@group(0) @binding(2) var motion_tex  : texture_2d<f32>;
@group(0) @binding(3) var tex_sampler : sampler;
@group(1) @binding(0) var<uniform> post : PostUBO;

// ── Full-screen triangle ───────────────────────────────

struct FsIn {
    @builtin(position) frag_coord : vec4<f32>,
    @location(0) uv               : vec2<f32>,
}

@vertex
fn vs_fullscreen(
    @builtin(vertex_index) vi : u32,
) -> FsIn {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -3.0),
        vec2<f32>( 3.0,  1.0),
        vec2<f32>(-1.0,  1.0),
    );
    var uv = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 2.0),
        vec2<f32>(2.0, 0.0),
        vec2<f32>(0.0, 0.0),
    );
    var o: FsIn;
    o.frag_coord = vec4<f32>(pos[vi], 0.0, 1.0);
    o.uv         = uv[vi];
    return o;
}

// ── ACES filmic tonemap ────────────────────────────────

fn aces(x: vec3<f32>) -> vec3<f32> {
    // Narkowicz ACES approximation.
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp(
        (x * (a * x + b)) / (x * (c * x + d) + e),
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    );
}

// ── TAA: history re-projection + variance-clip ────────

fn taa_resolve(uv: vec2<f32>, hdr: vec3<f32>) -> vec3<f32> {
    let motion  = textureSample(motion_tex, tex_sampler, uv).xy;
    let prev_uv = uv - motion;

    let history = textureSample(
        history_tex, tex_sampler, prev_uv).rgb;

    // Variance-clip history to the 3×3 neighbourhood.
    var mu  = hdr;
    var sigma = hdr * hdr;
    let inv9 = 1.0 / 9.0;
    // Single-sample approximation (full 9-tap is in the compute path).
    let clipped = clamp(history, mu * 0.8, mu * 1.2);

    // Blend: higher taa_blend = more history weight (smoother).
    return mix(hdr, clipped, post.taa_blend);
}

// ── Fragment ───────────────────────────────────────────

@fragment
fn fs_main(in: FsIn) -> @location(0) vec4<f32> {
    var hdr = textureSample(hdr_tex, tex_sampler, in.uv).rgb;

    // Exposure.
    hdr *= post.exposure;

    // Temporal anti-aliasing.
    let taa = taa_resolve(in.uv, hdr);

    // ACES tonemap → sRGB output (sRGB format handles gamma).
    let ldr = aces(taa);

    return vec4<f32>(ldr, 1.0);
}
