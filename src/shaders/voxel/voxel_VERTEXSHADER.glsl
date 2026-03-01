attribute vec3 a_position;
// xy = local quad UV (0..quadWidth, 0..quadHeight)
// z  = tile index (0–11 integer stored as float)
// w  = directional light multiplier
attribute vec4 a_uvl;

// Pass all four components interpolated to the fragment shader.
// fract() is intentionally applied THERE (after interpolation) so that
// integer corner values don't collapse every face to UV (0,0).
varying vec4 v_uvl;
varying float v_fogDist;  // eye-space distance for fog

uniform mat4 u_modelMatrix;
uniform mat4 u_viewMatrix;
uniform mat4 u_projectionMatrix;

void main() {
    v_uvl = a_uvl;
    vec4 eyePos = u_viewMatrix * u_modelMatrix * vec4(a_position, 1.0);
    v_fogDist = -eyePos.z;          // positive depth in front of camera
    gl_Position = u_projectionMatrix * eyePos;
}
