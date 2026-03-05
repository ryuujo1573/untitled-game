precision mediump float;

varying vec2 v_uv;
uniform sampler2D u_hdrBuffer;
// Exposure scale applied before tonemapping (1.0 = no change).
uniform float u_exposure;

// ── ACES filmic tone-mapping ────────────────────────────────────
// Approximation by Krzysztof Narkowicz (public domain):
// https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
vec3 aces(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
    vec3 hdr = texture2D(u_hdrBuffer, v_uv).rgb * u_exposure;

    // Tone-map from HDR linear → LDR linear, then gamma-encode to sRGB.
    vec3 ldr = aces(hdr);
    ldr = pow(ldr, vec3(1.0 / 2.2));

    gl_FragColor = vec4(ldr, 1.0);
}
