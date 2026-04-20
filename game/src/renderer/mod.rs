pub mod gpu;
pub mod render_loop;
pub mod types;

use std::sync::mpsc;

use render_loop::RenderCommand;

pub struct RendererHandle {
    pub tx: mpsc::Sender<RenderCommand>,
    pub join: Option<std::thread::JoinHandle<()>>,
}

impl Drop for RendererHandle {
    fn drop(&mut self) {
        let _ = self.tx.send(RenderCommand::Shutdown);
        if let Some(h) = self.join.take() {
            let _ = h.join();
        }
    }
}
