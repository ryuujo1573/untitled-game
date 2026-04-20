// ── Motion blur post-process pass ─────────────────────
//
// Reads the HDR colour buffer and the G-buffer velocity buffer
// (GBUF_MOTION .xy = UV-space velocity, computed in the G-buffer pass
// as:  mv = (curr_ndc - prev_ndc) * 0.5).
//
// Per pixel, samples the HDR buffer multiple times along the motion
// direction using a Gaussian kernel, then accumulates the weighted
// result into the MOTION_BLUR_HDR target.
//
// Group 0: MotionBlurUBO
//   0: mb_ubo (uniform)
//
// Group 1: scene textures + sampler
//   0: hdr_tex    (texture_2d<f32>, Rgba16Float HDR scene colour)
//   1: motion_tex (texture_2d<f32>, GBUF_MOTION .xy = UV-space velocity)
//   2: tex_sampler (sampler, linear-clamp)

// ── Uniform ───────────────────────────────────────────

struct MotionBlurUBO {
    /// Motion vector scale applied on top of the raw G-buffer velocity.
    /// Set to 0.0 when the pass is disabled to copy HDR without blur.
    intensity    : f32,
    /// Number of samples along the blur direction: 4 (Low), 8 (Medium),
    /// or 16 (High).
    sample_count : u32,
    /// Squared UV-space velocity magnitude below which blur is skipped.
    /// Avoids wasted work on stationary pixels.  Default: ~(0.0005)².
    threshold_sq : f32,
    /// 0 = normal output; 1 = velocity colour-map for debugging.
    debug_mode   : u32,
}

@group(0) @binding(0) var<uniform> mb : MotionBlurUBO;

@group(1) @binding(0) var hdr_tex    : texture_2d<f32>;
@group(1) @binding(1) var motion_tex : texture_2d<f32>;
@group(1) @binding(2) var tex_sampler: sampler;

// ── Full-screen triangle vertex shader ────────────────

struct FsIn {
    @builtin(position) frag_coord : vec4<f32>,
    @location(0) uv               : vec2<f32>,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> FsIn {
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

// ── Helpers ───────────────────────────────────────────

/// Convert HSV (each component [0,1]) to linear RGB.
/// Used only when debug_mode == 1 to colour-code velocity direction.
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
    let c   = v * s;
    let hi  = u32(h * 6.0) % 6u;
    let f_  = fract(h * 6.0);
    let x   = c * (1.0 - abs(f_ * 2.0 - 1.0));
    let m   = v - c;
    var rgb = vec3<f32>(0.0);
    switch hi {
        case 0u: { rgb = vec3<f32>(c, x, 0.0); }
        case 1u: { rgb = vec3<f32>(x, c, 0.0); }
        case 2u: { rgb = vec3<f32>(0.0, c, x); }
        case 3u: { rgb = vec3<f32>(0.0, x, c); }
        case 4u: { rgb = vec3<f32>(x, 0.0, c); }
        default: { rgb = vec3<f32>(c, 0.0, x); }
    }
    return rgb + m;
}

// ── Fragment ──────────────────────────────────────────

@fragment
fn fs_main(in: FsIn) -> @location(0) vec4<f32> {
    let uv = in.uv;

    // UV-space velocity written by gbuffer_terrain.wgsl:
    //   mv = (curr_ndc - prev_ndc) * 0.5
    // .xy encodes camera + object motion in UV-space deltas per frame.
    let raw_vel = textureSample(motion_tex, tex_sampler, uv).xy;
    let velocity = raw_vel * mb.intensity;

    // ── Debug: velocity colour map ────────────────────
    // Hue encodes direction; saturation + value encode magnitude.
    if mb.debug_mode == 1u {
        let mag   = length(velocity);
        let angle = atan2(velocity.y, velocity.x) * 0.15915494 + 0.5;
        let sat   = clamp(mag * 20.0, 0.0, 1.0);
        let val   = clamp(mag * 10.0 + 0.1, 0.0, 1.0);
        return vec4<f32>(hsv_to_rgb(angle, sat, val), 1.0);
    }

    // ── Early-exit: disabled or negligible motion ─────
    let vel_sq = dot(velocity, velocity);
    if mb.intensity <= 0.001 || vel_sq < mb.threshold_sq {
        return textureSample(hdr_tex, tex_sampler, uv);
    }

    // Clamp maximum blur extent to 5 % of screen space to prevent
    // extreme smearing at screen edges and very fast motion.
    let max_len: f32 = 0.05;
    let vel_len = sqrt(vel_sq);
    let vel = select(velocity, velocity * (max_len / vel_len), vel_len > max_len);

    // ── Gaussian accumulation along motion direction ──
    // Samples are evenly spaced in t ∈ [-0.5, 0.5] centred on the
    // current pixel.  Weight: exp(-8 t²)  → σ ≈ 0.25 in t-space.
    // This approximates a box-filter blur on motion-blurred exposure.
    var acc   = vec3<f32>(0.0);
    var w_sum = 0.0;
    let n     = mb.sample_count;
    let n_f   = f32(n - 1u);

    for (var i = 0u; i < n; i++) {
        let t      = f32(i) / n_f - 0.5;
        // Clamp to [0.001, 0.999] to avoid sampling outside the screen.
        let s_uv   = clamp(uv + vel * t, vec2<f32>(0.001), vec2<f32>(0.999));
        let s_hdr  = textureSample(hdr_tex, tex_sampler, s_uv).rgb;
        let w      = exp(-8.0 * t * t);
        acc   += s_hdr * w;
        w_sum += w;
    }

    return vec4<f32>(acc / w_sum, 1.0);
}
