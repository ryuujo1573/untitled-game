// Full-screen quad: clip-space positions are passed in directly (-1..1).
// No matrices needed — we just forward the UVs to the fragment stage.
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
    // Remap NDC [-1,1] → UV [0,1]
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
