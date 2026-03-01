precision mediump float;
varying vec2 v_uv;
varying float v_light;
uniform sampler2D u_atlas;

void main() {
    vec4 tex = texture2D(u_atlas, v_uv);
    gl_FragColor = vec4(tex.rgb * v_light, tex.a);
}
