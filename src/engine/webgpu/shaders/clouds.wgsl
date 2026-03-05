struct GFrameUniforms {
    view:           mat4x4f,
    projection:     mat4x4f,
    viewInverse:    mat4x4f,
    projInverse:    mat4x4f,
    sunDirStrength: vec4f,
    sunColor:       vec4f,
    ambientColor:   vec4f,
    fogColorNear:   vec4f,
    fogFar:         vec4f,
}

struct CloudUniforms {
    offsetX: f32,
    offsetZ: f32,
    alpha:   f32,
    uvScale: f32,
}

@group(0) @binding(0) var<uniform> frame: GFrameUniforms;
@group(0) @binding(1) var cloudTex: texture_2d<f32>;
@group(0) @binding(2) var cloudSamp: sampler;
@group(0) @binding(3) var<uniform> cloud: CloudUniforms;

struct VSIn {
    @location(0) pos: vec3f,
    @location(1) uv:  vec2f,
}

struct VSOut {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs_main(in: VSIn) -> VSOut {
    var out: VSOut;
    let wp = vec4f(in.pos.x + cloud.offsetX, in.pos.y, in.pos.z + cloud.offsetZ, 1.0);
    out.clip = frame.projection * frame.view * wp;
    out.uv = in.uv * cloud.uvScale;
    return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
    let s = textureSample(cloudTex, cloudSamp, fract(in.uv));
    let a = s.a * cloud.alpha;
    if (a < 0.03) {
        discard;
    }

    let lit = mix(frame.fogColorNear.rgb * 0.95, vec3f(1.0, 1.0, 1.0), 0.7);
    return vec4f(lit, a);
}
