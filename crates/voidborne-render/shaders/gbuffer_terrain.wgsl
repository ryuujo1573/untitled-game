// ── G-buffer terrain pass ─────────────────────────────
//
// Group 0: FrameUBO (uniform)
// Group 1: block_atlas (texture_2d_array), atlas_sampler
// Group 2: ChunkOriginUBO (uniform)
//
// Vertex slots:
//  0 Float32x3 – local section position
//  1 Snorm16x2 – oct-encoded normal   (→ vec2<f32> in [-1,1])
//  2 Snorm16x2 – oct-encoded tangent
//  3 Float32x4 – [u, v, tile_idx_f32, 0]
//  4 Float32x2 – [sky_light/15, block_light/15]
//
// Outputs: RT0 albedo | RT1 normal_rm | RT2 emission_ao | RT3 mv_light

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

struct ChunkOriginUBO {
    origin : vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame   : FrameUBO;
@group(1) @binding(0) var block_atlas      : texture_2d_array<f32>;
@group(1) @binding(1) var atlas_sampler    : sampler;
@group(2) @binding(0) var<uniform> chunk   : ChunkOriginUBO;

struct VertIn {
    @location(0) position   : vec3<f32>,
    @location(1) normal_oct : vec2<f32>,
    @location(2) tangent_oct: vec2<f32>,
    @location(3) uvl        : vec4<f32>,
    @location(4) light      : vec2<f32>,
}

struct VertOut {
    @builtin(position) clip_pos  : vec4<f32>,
    @location(0) curr_ndc        : vec2<f32>,
    @location(1) prev_ndc        : vec2<f32>,
    @location(2) normal_oct      : vec2<f32>,
    @location(3) tangent_oct     : vec2<f32>,
    @location(4) uv              : vec2<f32>,
    @location(5) light           : vec2<f32>,
    @location(6) @interpolate(flat) tile_id : u32,
}

@vertex
fn vs_main(v: VertIn) -> VertOut {
    let world = vec4<f32>(v.position + chunk.origin.xyz, 1.0);
    let clip      = frame.view_proj      * world;
    let prev_clip = frame.prev_view_proj * world;

    var o: VertOut;
    o.clip_pos    = clip;
    o.curr_ndc    = clip.xy / clip.w;
    o.prev_ndc    = prev_clip.xy / prev_clip.w;
    o.normal_oct  = v.normal_oct;
    o.tangent_oct = v.tangent_oct;
    o.uv          = v.uvl.xy;
    o.light       = v.light;
    o.tile_id     = u32(v.uvl.z);
    return o;
}

struct GBufferOut {
    @location(0) albedo_flags : vec4<f32>,   // RT0  Rgba8Unorm
    @location(1) normal_rm    : vec4<f32>,   // RT1  Rgba16Float
    @location(2) emission_ao  : vec4<f32>,   // RT2  Rgba8Unorm
    @location(3) mv_light     : vec4<f32>,   // RT3  Rgba16Float
}

@fragment
fn fs_main(in: VertOut) -> GBufferOut {
    let albedo = textureSample(
        block_atlas, atlas_sampler, in.uv, in.tile_id);
    if albedo.a < 0.5 { discard; }

    // Remap oct-normal from [-1,1] to [0,1] for 8/16-bit storage.
    let norm_stored = in.normal_oct * 0.5 + 0.5;

    // Motion vector: NDC delta * 0.5 → UV-space delta.
    let mv = (in.curr_ndc - in.prev_ndc) * 0.5;

    var o: GBufferOut;
    o.albedo_flags = vec4<f32>(albedo.rgb, 0.0);
    o.normal_rm    = vec4<f32>(norm_stored.x, norm_stored.y, 0.8, 0.0);
    o.emission_ao  = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    o.mv_light     = vec4<f32>(mv.x, mv.y, in.light.y, in.light.x);
    return o;
}
