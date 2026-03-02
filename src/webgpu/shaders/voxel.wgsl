// ─── Voxel world geometry shader ─────────────────────────────────────────────
//
// Vertex inputs:
//   @location(0) vec3  – chunk-local position
//   @location(1) vec4  – xy = local quad UV (0…quadSize), z = tile index, w = baked face light
//
// Bind groups:
//   @group(0) @binding(0) – FrameUniforms  (view, projection, ambient, fog)
//   @group(0) @binding(1) – atlas texture  (NEAREST, CLAMP)
//   @group(0) @binding(2) – atlas sampler
//   @group(1) @binding(0) – ChunkUniforms  (model matrix)
//
// fract() is applied in the fragment shader AFTER interpolation, exactly like
// the GLSL version, so integer UV corners don't all collapse to (0,0).

// ─── Uniform structs ─────────────────────────────────────────────────────────

struct FrameUniforms {
    view:       mat4x4f, // bytes  0-63
    projection: mat4x4f, // bytes 64-127
    ambient:    vec3f,   // bytes 128-139
    fogNear:    f32,     // byte  140
    fogColor:   vec3f,   // bytes 144-155
    fogFar:     f32,     // byte  156
}                        // total 160 bytes (16-byte aligned)

struct ChunkUniforms {
    model: mat4x4f, // bytes 0-63
}

// ─── Bindings ────────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> frame:        FrameUniforms;
@group(0) @binding(1) var          atlasTex:      texture_2d<f32>;
@group(0) @binding(2) var          atlasSampler:  sampler;

@group(1) @binding(0) var<uniform> chunk: ChunkUniforms;

// ─── Vertex shader ───────────────────────────────────────────────────────────

struct VsOut {
    @builtin(position) clipPos:  vec4f,
    @location(0)       uvl:      vec4f,   // xy=localUV, z=tileIdx, w=faceLight
    @location(1)       fogDist:  f32,
}

@vertex
fn vs_main(
    @location(0) a_position: vec3f,
    @location(1) a_uvl:      vec4f,
) -> VsOut {
    var out: VsOut;
    out.uvl      = a_uvl;
    let eyePos   = frame.view * chunk.model * vec4f(a_position, 1.0);
    out.fogDist  = -eyePos.z;   // positive eye-space depth
    out.clipPos  = frame.projection * eyePos;
    return out;
}

// ─── Fragment shader ─────────────────────────────────────────────────────────

const ATLAS_TILES: f32 = 12.0;
const TILE_W:      f32 = 1.0 / 12.0;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    // Build atlas UV: tile strip offset + fractional position within tile.
    let uv = vec2f(
        in.uvl.z * TILE_W + fract(in.uvl.x) * TILE_W,
        fract(in.uvl.y),
    );
    let tex   = textureSample(atlasTex, atlasSampler, uv);

    // Baked directional light × day-night ambient colour.
    let lit   = tex.rgb * in.uvl.w * frame.ambient;

    // Linear distance fog.
    let fogT  = clamp(
        (in.fogDist - frame.fogNear) / (frame.fogFar - frame.fogNear),
        0.0, 1.0
    );
    let color = mix(lit, frame.fogColor, fogT);

    return vec4f(color, tex.a);
}
