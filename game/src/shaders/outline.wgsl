struct FrameUniforms {
    view_proj: mat4x4<f32>,
    sun_dir: vec3<f32>,
    _pad: f32,
};

@group(0) @binding(0)
var<uniform> frame: FrameUniforms;

struct Vert {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@location(0) pos: vec3<f32>) -> Vert {
    let clip = frame.view_proj * vec4<f32>(pos, 1.0);
    // Push slightly toward camera to avoid z-fighting.
    var out: Vert;
    out.pos = vec4<f32>(
        clip.xy,
        clip.z - 0.001 * clip.w,
        clip.w,
    );
    return out;
}

@fragment
fn fs_main(in: Vert) -> @location(0) vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}
