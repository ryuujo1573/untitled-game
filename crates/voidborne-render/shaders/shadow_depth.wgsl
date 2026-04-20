// ── CSM shadow depth pass ─────────────────────────────
//
// Renders depth-only into one cascade slice of the shadow atlas.
// Group 0: cascade view-proj UBO (mat4x4<f32>)
// Group 1: ChunkOriginUBO
// Vertex slot 0: Float32x3 local position

struct CascadeUBO {
    view_proj : mat4x4<f32>,
}

struct ChunkOriginUBO {
    origin : vec4<f32>,
}

@group(0) @binding(0) var<uniform> cascade : CascadeUBO;
@group(1) @binding(0) var<uniform> chunk   : ChunkOriginUBO;

@vertex
fn vs_main(
    @location(0) position : vec3<f32>,
) -> @builtin(position) vec4<f32> {
    let world = vec4<f32>(position + chunk.origin.xyz, 1.0);
    return cascade.view_proj * world;
}
