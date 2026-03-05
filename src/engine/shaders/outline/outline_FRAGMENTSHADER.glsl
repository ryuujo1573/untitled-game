precision mediump float;

uniform float u_alpha;

void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.75 * u_alpha);
}
