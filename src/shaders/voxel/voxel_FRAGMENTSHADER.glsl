precision mediump float;

// Interpolated from the vertex shader: xy = localUV, z = tileIndex, w = baked face light
varying vec4 v_uvl;
uniform sampler2D u_atlas;

const float ATLAS_TILES = 12.0;
const float TILE_W      = 1.0 / ATLAS_TILES;

// ── Day-night lighting ──────────────────────────────────────────
// Ambient light colour driven by the sun position each frame.
uniform vec3 u_ambientLight;   // e.g. (0.9,0.85,0.7) at noon, (0.05,0.05,0.1) at night

// ── Distance fog ───────────────────────────────────────────────
uniform vec3  u_fogColor;      // matches gl.clearColor sky tint
uniform float u_fogNear;       // world-units distance where fog begins
uniform float u_fogFar;        // world-units distance of full fog

// Fragment distance from camera (set by vertex shader).
varying float v_fogDist;

void main() {
    // fract() is applied HERE so it works on interpolated (fractional) values
    // rather than on the integer-valued vertex corners.
    vec2 uv = vec2(v_uvl.z * TILE_W + fract(v_uvl.x) * TILE_W,
                   fract(v_uvl.y));
    vec4 tex = texture2D(u_atlas, uv);

    // v_uvl.w = baked face multiplier (top=1.0, sides=0.8, bottom=0.6)
    vec3 lit = tex.rgb * v_uvl.w * u_ambientLight;

    // Linear distance fog.
    float fogT = clamp((v_fogDist - u_fogNear) / (u_fogFar - u_fogNear), 0.0, 1.0);
    vec3 color = mix(lit, u_fogColor, fogT);

    gl_FragColor = vec4(color, tex.a);
}
