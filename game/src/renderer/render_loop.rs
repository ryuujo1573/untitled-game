use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use glam::{IVec2, Mat4, Vec3};
use voidborne_math::coord::ChunkPos;
use voidborne_math::pack::{oct_encode, oct_to_snorm16};
use voidborne_render::{FrameData, MotionBlurSettings, VoidborneRenderer};
use voidborne_render::passes::motion_blur::MotionBlurQuality as RenderMBQuality;
use voidborne_world::mesh::SectionMesh;

use crate::app::{MotionBlurQuality, VideoSettings};
use crate::renderer::types::{ChunkMeshData, EguiFrame, FrameState};

pub enum RenderCommand {
    LoadChunk(ChunkMeshData),
    UnloadChunk {
        cx: i32,
        cz: i32,
    },
    UpdateFrame(FrameState),
    UpdateEgui(EguiFrame),
    Resize {
        width: u32,
        height: u32,
    },
    /// Apply new video settings: update present mode + inner frame cap.
    SetVideoSettings(VideoSettings),
    /// Apply new motion blur settings to the render pass.
    SetMotionBlur {
        enabled:   bool,
        intensity: f32,
        quality:   MotionBlurQuality,
    },
    Shutdown,
}

pub type SharedGpu = Arc<Mutex<VoidborneRenderer>>;

pub fn spawn_render_thread(
    renderer: VoidborneRenderer,
) -> (mpsc::Sender<RenderCommand>, std::thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel();
    let shared = Arc::new(Mutex::new(renderer));

    let handle = std::thread::spawn(move || {
        render_loop(rx, shared);
    });

    (tx, handle)
}

// ── Mesh format bridge ────────────────────────────────────────────────
//
// The game's chunk mesher produces `ChunkMeshData` with raw float3 normals.
// `VoidborneRenderer` expects `SectionMesh` with oct-encoded snorm16 normals.

fn section_mesh_from_chunk_data(data: &ChunkMeshData) -> SectionMesh {
    let n = data.vertex_count as usize;

    // Positions: direct copy.
    let positions = data.positions.clone();

    // Normals: raw xyz → oct_encode → snorm16 pair.
    let mut normals_oct = Vec::with_capacity(n * 2);
    for i in 0..n {
        let nx = data.normals[i * 3];
        let ny = data.normals[i * 3 + 1];
        let nz = data.normals[i * 3 + 2];
        let normal = Vec3::new(nx, ny, nz).normalize_or_zero();
        let enc = oct_encode(normal);
        let [a, b] = oct_to_snorm16(enc);
        normals_oct.push(a);
        normals_oct.push(b);
    }

    // Tangents: derive from normal axis; choose perpendicular via cross product.
    let mut tangents_oct = Vec::with_capacity(n * 2);
    for i in 0..n {
        let nx = data.normals[i * 3];
        let ny = data.normals[i * 3 + 1];
        let nz = data.normals[i * 3 + 2];
        let normal = Vec3::new(nx, ny, nz).normalize_or_zero();
        let up = if normal.y.abs() > 0.99 { Vec3::X } else { Vec3::Y };
        let tangent = up.cross(normal).normalize_or(Vec3::X);
        let enc = oct_encode(tangent);
        let [a, b] = oct_to_snorm16(enc);
        tangents_oct.push(a);
        tangents_oct.push(b);
    }

    // UVL: [u, v, tile, light_mult] → [u, v, tile, 0.0]
    // Drop the face ambient multiplier; the deferred lighting pass
    // computes illumination from the G-buffer sun direction.
    let mut uvl = Vec::with_capacity(n * 4);
    for i in 0..n {
        uvl.push(data.uvls[i * 4]);     // u
        uvl.push(data.uvls[i * 4 + 1]); // v
        uvl.push(data.uvls[i * 4 + 2]); // tile index (f32)
        uvl.push(0.0_f32);              // pad
    }

    // Light: direct copy.
    let light = data.lights.clone();

    SectionMesh {
        positions,
        normals_oct,
        tangents_oct,
        uvl,
        light,
        vertex_count: data.vertex_count,
    }
}

// ── FrameData builder ─────────────────────────────────────────────────

fn frame_data_from_state(state: &FrameState, prev_vp: Mat4, time: f32) -> FrameData {
    let view = Mat4::from_cols_array(&state.camera.view_matrix);
    let proj = Mat4::from_cols_array(&state.camera.projection_matrix);
    let view_proj = proj * view;
    let cam_pos = Vec3::from_array(state.camera.position);
    let sun_dir = Vec3::from_slice(&state.sun_direction).normalize_or(Vec3::Y);

    FrameData {
        view,
        proj,
        view_proj,
        prev_view_proj: prev_vp,
        cam_pos,
        sun_dir,
        sun_intensity: 6.0,
        time,
        near_z: 0.1,
        far_z: 1024.0,
    }
}

// ── Render loop ───────────────────────────────────────────────────────

fn render_loop(rx: mpsc::Receiver<RenderCommand>, renderer: SharedGpu) {
    let mut target_dt = Duration::from_micros(1);
    let mut frame_state = FrameState {
        camera: crate::renderer::types::CameraState {
            position: [0.0, 10.0, 0.0],
            view_matrix: identity_f32_16(),
            projection_matrix: identity_f32_16(),
        },
        sun_direction: [0.3, 0.9, 0.2],
        time: 0.0,
        targeted_block: None,
    };

    let mut retained_primitives: Vec<egui::ClippedPrimitive> = Vec::new();
    let mut retained_screen = egui_wgpu::ScreenDescriptor {
        size_in_pixels: [1280, 720],
        pixels_per_point: 1.0,
    };
    let mut egui_ready = false;

    let mut prev_view_proj = Mat4::IDENTITY;
    let mut accumulated_time = 0.0_f32;

    loop {
        let frame_start = Instant::now();

        loop {
            match rx.try_recv() {
                Ok(RenderCommand::LoadChunk(data)) => {
                    if let Ok(mut r) = renderer.lock() {
                        let pos = ChunkPos(IVec2::new(data.cx, data.cz));
                        if data.vertex_count == 0 {
                            r.unload_chunk(pos);
                        } else {
                            let mesh = section_mesh_from_chunk_data(&data);
                            r.load_chunk(pos, &mesh);
                        }
                    }
                }
                Ok(RenderCommand::UnloadChunk { cx, cz }) => {
                    if let Ok(mut r) = renderer.lock() {
                        r.unload_chunk(ChunkPos(IVec2::new(cx, cz)));
                    }
                }
                Ok(RenderCommand::UpdateFrame(s)) => {
                    frame_state = s;
                }
                Ok(RenderCommand::UpdateEgui(ef)) => {
                    if let Ok(mut r) = renderer.lock() {
                        r.apply_egui_textures(&ef.textures_delta);
                    }
                    retained_primitives = ef.primitives;
                    retained_screen = ef.screen_descriptor;
                    egui_ready = true;
                }
                Ok(RenderCommand::Resize { width, height }) => {
                    if let Ok(mut r) = renderer.lock() {
                        r.resize(width, height);
                    }
                }
                Ok(RenderCommand::SetVideoSettings(vs)) => {
                    if let Ok(mut r) = renderer.lock() {
                        r.set_present_mode(vs.vsync.to_wgpu());
                    }
                    target_dt = Duration::from_micros(1);
                }
                Ok(RenderCommand::SetMotionBlur { enabled, intensity, quality }) => {
                    if let Ok(mut r) = renderer.lock() {
                        r.update_motion_blur(MotionBlurSettings {
                            enabled,
                            intensity,
                            quality: match quality {
                                MotionBlurQuality::Low    => RenderMBQuality::Low,
                                MotionBlurQuality::Medium => RenderMBQuality::Medium,
                                MotionBlurQuality::High   => RenderMBQuality::High,
                            },
                            debug_viz: false,
                        });
                    }
                }
                Ok(RenderCommand::Shutdown) => return,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        // Build and upload per-frame uniforms.
        let frame_data = frame_data_from_state(&frame_state, prev_view_proj, accumulated_time);
        let current_vp = frame_data.view_proj;

        if let Ok(mut r) = renderer.lock() {
            r.update_frame(frame_data);

            let egui = if egui_ready {
                Some((&retained_primitives[..], &retained_screen))
            } else {
                None
            };

            match r.render(frame_state.targeted_block, egui) {
                Ok(()) => {}
                Err(wgpu::SurfaceError::Lost) => {
                    let w = r.ctx_width();
                    let h = r.ctx_height();
                    r.resize(w, h);
                }
                Err(e) => log::error!("render error: {e:?}"),
            }
        }

        prev_view_proj = current_vp;
        accumulated_time += frame_start.elapsed().as_secs_f32();
        if accumulated_time > 3600.0 {
            accumulated_time -= 3600.0;
        }

        let elapsed = frame_start.elapsed();
        if elapsed < target_dt {
            std::thread::sleep(target_dt - elapsed);
        }
    }
}

fn identity_f32_16() -> [f32; 16] {
    [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
}

