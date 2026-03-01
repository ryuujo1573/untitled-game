attribute vec3 a_position;
attribute vec3 a_uvl; // xy = atlas UV coords, z = light multiplier
varying vec2 v_uv;
varying float v_light;

uniform mat4 u_modelMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;

void main() {
    v_uv    = a_uvl.xy;
    v_light = a_uvl.z;
    gl_Position = u_projectionMatrix * u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
}
