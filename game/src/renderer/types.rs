/// Camera state for the GPU frame.
pub struct CameraState {
    pub position: [f32; 3],
    /// Column-major 4×4 view matrix.
    pub view_matrix: [f32; 16],
    /// Column-major 4×4 projection matrix.
    pub projection_matrix: [f32; 16],
}

/// Per-frame uniforms passed to the render thread.
pub struct FrameState {
    pub camera: CameraState,
    pub sun_direction: [f32; 3],
    pub time: f32,
    /// World-space block coords of the targeted block,
    /// if any (used for the selection outline).
    pub targeted_block: Option<[i32; 3]>,
}

/// Egui paint output for one frame,
/// sent from the main thread to the render thread.
pub struct EguiFrame {
    pub primitives: Vec<egui::ClippedPrimitive>,
    pub textures_delta: egui::TexturesDelta,
    pub screen_descriptor: egui_wgpu::ScreenDescriptor,
}

/// Chunk mesh data for upload to the GPU.
pub struct ChunkMeshData {
    pub cx: i32,
    pub cz: i32,
    /// Flat f32 array: [x,y,z, …]
    pub positions: Vec<f32>,
    /// Flat f32 array: [nx,ny,nz, …]
    pub normals: Vec<f32>,
    /// Flat f32 array: [u,v,tile,light, …]
    pub uvls: Vec<f32>,
    /// Flat f32 array: [skyLight/15, blockLight/15, …]
    pub lights: Vec<f32>,
    pub vertex_count: u32,
}
