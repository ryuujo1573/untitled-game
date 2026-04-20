use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::renderer::gpu::GpuContext;
use crate::renderer::types::{ChunkMeshData, EguiFrame, FrameState};

pub enum RenderCommand {
    LoadChunk(ChunkMeshData),
    UnloadChunk { cx: i32, cz: i32 },
    UpdateFrame(FrameState),
    UpdateEgui(EguiFrame),
    Resize { width: u32, height: u32 },
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
    let target_dt = Duration::from_secs_f64(1.0 / 120.0);
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
    let mut latest_egui: Option<EguiFrame> = None;

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
                Ok(RenderCommand::UpdateEgui(mut new_ef)) => {
                    // Merge texture uploads from any skipped frame so that
                    // glyph atlas updates are never silently dropped when the
                    // main thread produces frames faster than the render thread
                    // consumes them.
                    if let Some(old_ef) = latest_egui.take() {
                        // Old uploads go first; new uploads overwrite them if
                        // the same TextureId appears in both (last write wins).
                        let mut merged = old_ef.textures_delta.set;
                        merged.extend(new_ef.textures_delta.set);
                        new_ef.textures_delta.set = merged;
                    }
                    latest_egui = Some(new_ef);
                }
                Ok(RenderCommand::Resize { width, height }) => {
                    if let Ok(mut g) = gpu.lock() {
                        g.resize(width, height);
                    }
                }
                Ok(RenderCommand::Shutdown) => return,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        if let Ok(mut g) = gpu.lock() {
            g.render(&frame_state, latest_egui.take());
        }

        let elapsed = frame_start.elapsed();
        if elapsed < target_dt {
            std::thread::sleep(target_dt - elapsed);
        }
    }
}
