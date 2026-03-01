attribute vec3 a_position;
// xy = local quad UV (0..quadWidth, 0..quadHeight)
// z  = tile index (0–3 integer stored as float)
// w  = directional light multiplier
attribute vec4 a_uvl;
varying vec2 v_uv;
varying float v_light;

uniform mat4 u_modelMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;

const float ATLAS_TILES = 4.0;
const float TILE_W      = 1.0 / ATLAS_TILES;

void main() {
    // fract() tiles the atlas sprite across the merged greedy quad.
    // For a 1×1 quad the UV still spans exactly one tile (0→1).
    v_uv    = vec2(a_uvl.z * TILE_W + fract(a_uvl.x) * TILE_W,
                   fract(a_uvl.y));
    v_light = a_uvl.w;
    gl_Position = u_projectionMatrix * u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
}
