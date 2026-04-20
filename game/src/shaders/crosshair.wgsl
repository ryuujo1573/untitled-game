struct Vert {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_main(@location(0) pos: vec2<f32>) -> Vert {
    return Vert(vec4<f32>(pos, 0.0, 1.0));
}

@fragment
fn fs_main(in: Vert) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, 0.9);
}
