precision mediump float;

// Interpolated from the vertex shader: xy = localUV, z = tileIndex, w = light
varying vec4 v_uvl;
uniform sampler2D u_atlas;

const float ATLAS_TILES = 12.0;
const float TILE_W      = 1.0 / ATLAS_TILES;

void main() {
    // fract() is applied HERE so it works on interpolated (fractional) values
    // rather than on the integer-valued vertex corners.
    vec2 uv = vec2(v_uvl.z * TILE_W + fract(v_uvl.x) * TILE_W,
                   fract(v_uvl.y));
    vec4 tex = texture2D(u_atlas, uv);
    gl_FragColor = vec4(tex.rgb * v_uvl.w, tex.a);
}
