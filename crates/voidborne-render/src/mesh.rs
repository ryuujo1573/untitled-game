//! GPU mesh upload from [`voidborne_world::mesh::SectionMesh`].

use bytemuck;
use wgpu;
use wgpu::util::DeviceExt;
use voidborne_world::mesh::SectionMesh;
use voidborne_math::coord::ChunkPos;

/// GPU-resident SoA vertex buffers for one meshed section.
pub struct GpuMesh {
    /// `Float32x3` — local section-space xyz.
    pub pos_buf:     wgpu::Buffer,
    /// `Snorm16x2` — oct-encoded normal, two i16 per vertex.
    pub normal_buf:  wgpu::Buffer,
    /// `Snorm16x2` — oct-encoded tangent.
    pub tangent_buf: wgpu::Buffer,
    /// `Float32x4` — [u, v, tile_as_f32, 0].
    pub uvl_buf:     wgpu::Buffer,
    /// `Float32x2` — [sky/15, block/15].
    pub light_buf:   wgpu::Buffer,
    pub vertex_count: u32,
}

impl GpuMesh {
    /// Upload a section mesh to GPU buffers.
    ///
    /// Returns `None` if the mesh is empty (air section).
    pub fn upload(
        device: &wgpu::Device,
        mesh: &SectionMesh,
    ) -> Option<Self> {
        if mesh.vertex_count == 0 {
            return None;
        }

        macro_rules! vbuf {
            ($label:literal, $data:expr) => {
                device.create_buffer_init(
                    &wgpu::util::BufferInitDescriptor {
                        label: Some($label),
                        contents: bytemuck::cast_slice($data),
                        usage: wgpu::BufferUsages::VERTEX,
                    },
                )
            };
        }

        Some(Self {
            pos_buf:     vbuf!("mesh_pos",     &mesh.positions),
            normal_buf:  vbuf!("mesh_normals", &mesh.normals_oct),
            tangent_buf: vbuf!("mesh_tangents",&mesh.tangents_oct),
            uvl_buf:     vbuf!("mesh_uvl",     &mesh.uvl),
            light_buf:   vbuf!("mesh_light",   &mesh.light),
            vertex_count: mesh.vertex_count,
        })
    }

    /// Wgpu vertex buffer layout descriptors for all five slots.
    ///
    /// Slot assignment:
    /// - 0 → positions   (`Float32x3`, 12 B/vtx)
    /// - 1 → normals_oct (`Snorm16x2`,  4 B/vtx)
    /// - 2 → tangents_oct(`Snorm16x2`,  4 B/vtx)
    /// - 3 → uvl         (`Float32x4`, 16 B/vtx)
    /// - 4 → light       (`Float32x2`,  8 B/vtx)
    pub fn layouts() -> [wgpu::VertexBufferLayout<'static>; 5] {
        [
            wgpu::VertexBufferLayout {
                array_stride: 12,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 0,
                    shader_location: 0,
                }],
            },
            wgpu::VertexBufferLayout {
                array_stride: 4,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Snorm16x2,
                    offset: 0,
                    shader_location: 1,
                }],
            },
            wgpu::VertexBufferLayout {
                array_stride: 4,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Snorm16x2,
                    offset: 0,
                    shader_location: 2,
                }],
            },
            wgpu::VertexBufferLayout {
                array_stride: 16,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x4,
                    offset: 0,
                    shader_location: 3,
                }],
            },
            wgpu::VertexBufferLayout {
                array_stride: 8,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 0,
                    shader_location: 4,
                }],
            },
        ]
    }

    /// Bind all five vertex buffers onto render pass slots 0-4.
    pub fn bind<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
    ) {
        pass.set_vertex_buffer(0, self.pos_buf.slice(..));
        pass.set_vertex_buffer(1, self.normal_buf.slice(..));
        pass.set_vertex_buffer(2, self.tangent_buf.slice(..));
        pass.set_vertex_buffer(3, self.uvl_buf.slice(..));
        pass.set_vertex_buffer(4, self.light_buf.slice(..));
    }
}

/// A loaded chunk mesh on the GPU, with its chunk-origin UBO.
pub struct ChunkEntry {
    pub pos:       ChunkPos,
    pub mesh:      GpuMesh,
    pub origin_buf: wgpu::Buffer,
    pub chunk_bind_group: wgpu::BindGroup,
}
