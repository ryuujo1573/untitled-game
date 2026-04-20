use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::app::VideoSettings;
use crate::renderer::gpu::GpuContext;
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
    Shutdown,
}

pub type SharedGpu = Arc<Mutex<GpuContext>>;

pub fn spawn_render_thread(
    gpu: GpuContext,
) -> (mpsc::Sender<RenderCommand>, std::thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel();
    let gpu = Arc::new(Mutex::new(gpu));

    let handle = std::thread::spawn(move || {
        render_loop(rx, gpu);
    });

    (tx, handle)
}

fn identity_f32_16() -> [f32; 16] {
    [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]
}

fn render_loop(rx: mpsc::Receiver<RenderCommand>, gpu: SharedGpu) {
    // The render thread keeps its own target_dt independently of the
    // main-thread frame cap.  It starts at "uncapped" (1 µs) and is
    // updated whenever VideoSettings arrive.
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
    // Primitives + screen descriptor retained across frames so egui is
    // composited on every rendered frame, not just the one where a new
    // EguiFrame arrived.  Texture uploads are applied eagerly on arrival
    // and must not be re-applied on subsequent frames.
    let mut retained_primitives: Vec<egui::ClippedPrimitive> = Vec::new();
    let mut retained_screen: egui_wgpu::ScreenDescriptor = egui_wgpu::ScreenDescriptor {
        size_in_pixels: [1280, 720],
        pixels_per_point: 1.0,
    };
    let mut egui_ready = false; // true once we have at least one frame

    loop {
        let frame_start = Instant::now();

        loop {
            match rx.try_recv() {
                Ok(RenderCommand::LoadChunk(data)) => {
                    if let Ok(mut g) = gpu.lock() {
                        g.load_chunk(data);
                    }
                }
                Ok(RenderCommand::UnloadChunk { cx, cz }) => {
                    if let Ok(mut g) = gpu.lock() {
                        g.unload_chunk(cx, cz);
                    }
                }
                Ok(RenderCommand::UpdateFrame(s)) => {
                    frame_state = s;
                }
                Ok(RenderCommand::UpdateEgui(ef)) => {
                    // Upload / free textures immediately.  These calls write
                    // directly to the queue without needing an encoder, so
                    // they are safe to do outside of render().
                    if let Ok(mut g) = gpu.lock() {
                        g.apply_egui_textures(&ef.textures_delta);
                    }
                    // Retain draw data for every subsequent render frame.
                    retained_primitives = ef.primitives;
                    retained_screen = ef.screen_descriptor;
                    egui_ready = true;
                }
                Ok(RenderCommand::Resize { width, height }) => {
                    if let Ok(mut g) = gpu.lock() {
                        g.resize(width, height);
                    }
                }
                Ok(RenderCommand::SetVideoSettings(vs)) => {
                    if let Ok(mut g) = gpu.lock() {
                        g.set_present_mode(vs.vsync.to_wgpu());
                    }
                    // The software cap in the render thread is only relevant
                    // when V-Sync is off and no main-thread limit is active.
                    // Keep it at near-zero; pacing is owned by the main thread.
                    target_dt = Duration::from_micros(1);
                }
                Ok(RenderCommand::Shutdown) => return,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        if let Ok(mut g) = gpu.lock() {
            let egui = if egui_ready {
                Some((&retained_primitives[..], &retained_screen))
            } else {
                None
            };
            g.render(&frame_state, egui);
        }

        let elapsed = frame_start.elapsed();
        if elapsed < target_dt {
            std::thread::sleep(target_dt - elapsed);
        }
    }
}
