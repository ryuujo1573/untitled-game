//! Greedy mesher for a single 16³ section.
//!
//! Ported and upgraded from `game/src/world/chunk.rs`.
//! Produces a `SectionMesh` whose vertex buffers target the new
//! deferred G-buffer layout (SoA: positions, oct-normals, tangents,
//! UVL, light).  All six face directions are handled by the same
//! generic sweep loop.
//!
//! ## Cross-section boundary light
//!
//! A `LightSampler` trait lets the caller (the `World`) supply
//! correct light values that span section/column boundaries.
//!
//! ## Octahedral normals
//!
//! Normals and tangents are stored as snorm16 pairs using the
//! `voidborne_math::pack` functions, ready for upload to RT1.

use voidborne_math::pack::{oct_encode, oct_to_snorm16};
use voidborne_math::glam::Vec3;

use crate::block::{block_registry, BlockState};
use crate::section::Section;

// ── Output ────────────────────────────────────────────

/// Mesh data for one section, in SoA layout.
///
/// Ready to upload to GPU buffers.
#[derive(Default)]
pub struct SectionMesh {
    /// `[x, y, z]` per vertex (local section-space, 0.0..16.0).
    pub positions: Vec<f32>,
    /// Octahedral-encoded normal as `[snorm16, snorm16]` per vertex.
    pub normals_oct: Vec<i16>,
    /// Octahedral-encoded tangent as `[snorm16, snorm16]` per vertex.
    pub tangents_oct: Vec<i16>,
    /// `[u, v, tile_index, _pad]` per vertex (u/v local to face).
    pub uvl: Vec<f32>,
    /// `[sky/15, block/15]` per vertex.
    pub light: Vec<f32>,
    pub vertex_count: u32,
}

// ── Light sampler ─────────────────────────────────────

pub trait LightSampler {
    fn sky_light(&self, wx: i32, wy: i32, wz: i32) -> u8;
    fn block_light(&self, wx: i32, wy: i32, wz: i32) -> u8;
}

// ── Face definitions ──────────────────────────────────

struct FaceDef {
    /// 0=+Y 1=-Y 2=+X 3=-X 4=+Z 5=-Z
    face_index: usize,
    slice_axis: usize, // 0=X, 1=Y, 2=Z
    dim0: usize,
    dim1: usize,
    neighbor: [i32; 3],
    /// +1 or -1: outward direction along slice_axis
    normal_sign: i32,
    /// Normal vector (un-normalised, already unit).
    normal: Vec3,
    /// Tangent vector (U axis for face UVs).
    tangent: Vec3,
}

const FACES: [FaceDef; 6] = [
    FaceDef {
        face_index: 0,
        slice_axis: 1,
        dim0: 0,
        dim1: 2,
        neighbor: [0, 1, 0],
        normal_sign: 1,
        normal: Vec3::Y,
        tangent: Vec3::X,
    }, // +Y
    FaceDef {
        face_index: 1,
        slice_axis: 1,
        dim0: 0,
        dim1: 2,
        neighbor: [0, -1, 0],
        normal_sign: -1,
        normal: Vec3::NEG_Y,
        tangent: Vec3::X,
    }, // -Y
    FaceDef {
        face_index: 2,
        slice_axis: 0,
        dim0: 2,
        dim1: 1,
        neighbor: [1, 0, 0],
        normal_sign: 1,
        normal: Vec3::X,
        tangent: Vec3::Z,
    }, // +X
    FaceDef {
        face_index: 3,
        slice_axis: 0,
        dim0: 2,
        dim1: 1,
        neighbor: [-1, 0, 0],
        normal_sign: -1,
        normal: Vec3::NEG_X,
        tangent: Vec3::NEG_Z,
    }, // -X
    FaceDef {
        face_index: 4,
        slice_axis: 2,
        dim0: 0,
        dim1: 1,
        neighbor: [0, 0, 1],
        normal_sign: 1,
        normal: Vec3::Z,
        tangent: Vec3::X,
    }, // +Z
    FaceDef {
        face_index: 5,
        slice_axis: 2,
        dim0: 0,
        dim1: 1,
        neighbor: [0, 0, -1],
        normal_sign: -1,
        normal: Vec3::NEG_Z,
        tangent: Vec3::NEG_X,
    }, // -Z
];

// ── Section block/light accessor ──────────────────────

/// Wraps the section being meshed plus border sections (for
/// cross-boundary face culling).
pub struct MeshContext<'a> {
    /// The section under mesh.
    pub section: &'a Section,
    /// World-space origin of this section (in block coordinates).
    pub origin_wx: i32,
    pub origin_wy: i32,
    pub origin_wz: i32,
    /// Light sampler for cross-boundary lookups.
    pub light: &'a dyn LightSampler,
    /// Callable for getting a block at a **local** coordinate that may
    /// be outside `[0,16)` — the caller looks it up in adjacent
    /// sections.
    pub get_block: &'a dyn Fn(i32, i32, i32) -> BlockState,
}

// ── Greedy mesher ─────────────────────────────────────

/// Build a greedy mesh for one 16³ section.
pub fn mesh_section(ctx: &MeshContext<'_>) -> SectionMesh {
    let reg = block_registry();
    let mut out = SectionMesh::default();

    let mut mask = vec![-1i64; 16 * 16];
    let mut used = vec![false; 16 * 16];
    let mut coord = [0i32; 3];

    // Pre-compute oct-encoded normals & tangents for each face.
    let face_oct_normals: Vec<[i16; 2]> =
        FACES.iter().map(|f| oct_to_snorm16(oct_encode(f.normal))).collect();
    let face_oct_tangents: Vec<[i16; 2]> =
        FACES.iter().map(|f| oct_to_snorm16(oct_encode(f.tangent))).collect();

    for face in &FACES {
        let norm_oct = face_oct_normals[face.face_index];
        let tan_oct = face_oct_tangents[face.face_index];

        for s in 0..16usize {
            // ── Build visibility mask ─────────────────
            mask.fill(-1);

            for j in 0..16usize {
                for i in 0..16usize {
                    coord[face.slice_axis] = s as i32;
                    coord[face.dim0] = i as i32;
                    coord[face.dim1] = j as i32;

                    let state = (ctx.get_block)(
                        coord[0], coord[1], coord[2],
                    );
                    if reg.is_air(state) {
                        continue;
                    }

                    let nx = coord[0] + face.neighbor[0];
                    let ny = coord[1] + face.neighbor[1];
                    let nz = coord[2] + face.neighbor[2];
                    let nbr = (ctx.get_block)(nx, ny, nz);
                    if reg.is_opaque(nbr) {
                        continue;
                    }

                    // Light at air-side neighbour.
                    let (sky_l, block_l) = {
                        let wx = ctx.origin_wx + nx;
                        let wy = ctx.origin_wy + ny;
                        let wz = ctx.origin_wz + nz;
                        (
                            ctx.light.sky_light(wx, wy, wz),
                            ctx.light.block_light(wx, wy, wz),
                        )
                    };

                    let props = match reg.props(state.id) {
                        Some(p) => p,
                        None => continue,
                    };
                    let tile = props.face_tiles[face.face_index] as i64;
                    // Encode: tile | sky_light<<8 | block_light<<12
                    let encoded =
                        tile | ((sky_l as i64) << 8) | ((block_l as i64) << 12);
                    mask[i + j * 16] = encoded;
                }
            }

            // ── Greedy sweep ──────────────────────────
            used.fill(false);

            for j in 0..16usize {
                for i in 0..16usize {
                    if used[i + j * 16] {
                        continue;
                    }
                    let encoded = mask[i + j * 16];
                    if encoded < 0 {
                        continue;
                    }

                    let mut w = 1usize;
                    while i + w < 16
                        && !used[i + w + j * 16]
                        && mask[i + w + j * 16] == encoded
                    {
                        w += 1;
                    }

                    let mut h = 1usize;
                    'outer: while j + h < 16 {
                        for k in i..i + w {
                            if used[k + (j + h) * 16]
                                || mask[k + (j + h) * 16] != encoded
                            {
                                break 'outer;
                            }
                        }
                        h += 1;
                    }

                    for dj in 0..h {
                        for di in 0..w {
                            used[i + di + (j + dj) * 16] = true;
                        }
                    }

                    let tile = (encoded & 0xFF) as f32;
                    let sky_l = ((encoded >> 8) & 0xF) as f32 / 15.0;
                    let block_l = ((encoded >> 12) & 0xF) as f32 / 15.0;

                    let sv = if face.normal_sign > 0 {
                        (s + 1) as i32
                    } else {
                        s as i32
                    };

                    emit_quad(
                        &mut out,
                        face, sv,
                        i as i32, j as i32,
                        w as i32, h as i32,
                        tile, sky_l, block_l,
                        norm_oct, tan_oct,
                    );
                }
            }
        }
    }

    out
}

// ── Quad emitter ──────────────────────────────────────

fn emit_quad(
    out: &mut SectionMesh,
    face: &FaceDef,
    sv: i32,
    i: i32, j: i32,
    w: i32, h: i32,
    tile: f32,
    sky: f32,
    block: f32,
    norm_oct: [i16; 2],
    tan_oct: [i16; 2],
) {
    // Four corners of the quad in local section-space.
    let corners = quad_corners(face, sv, i, j, w, h);
    let uvs: [[f32; 2]; 4] = [
        [0.0, 0.0],
        [w as f32, 0.0],
        [w as f32, h as f32],
        [0.0, h as f32],
    ];

    // Two triangles: (0,1,2) and (0,2,3).
    for &vi in &[0, 1, 2, 0, 2, 3usize] {
        let p = corners[vi];
        out.positions.extend_from_slice(&p);
        out.normals_oct.extend_from_slice(&norm_oct);
        out.tangents_oct.extend_from_slice(&tan_oct);
        let [u, v] = uvs[vi];
        out.uvl.extend_from_slice(&[u, v, tile, 0.0]);
        out.light.extend_from_slice(&[sky, block]);
        out.vertex_count += 1;
    }
}

/// Produce the four corner positions of a greedy quad.
fn quad_corners(
    face: &FaceDef,
    sv: i32,
    i: i32, j: i32,
    w: i32, h: i32,
) -> [[f32; 3]; 4] {
    let mut corners = [[0f32; 3]; 4];
    let offsets: [[i32; 2]; 4] = [[0, 0], [w, 0], [w, h], [0, h]];
    for (c, [di, dj]) in corners.iter_mut().zip(offsets) {
        c[face.slice_axis] = sv as f32;
        c[face.dim0] = (i + di) as f32;
        c[face.dim1] = (j + dj) as f32;
    }
    corners
}
