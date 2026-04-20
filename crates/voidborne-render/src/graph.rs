//! Minimal linear render graph.
//!
//! Passes are added in submission order.  Each pass is a closure that
//! records GPU commands into a shared `CommandEncoder`.  Wgpu inserts
//! the necessary resource barriers automatically as passes transition
//! between render-attachment and shader-read usage.

use wgpu;
use crate::texture_pool::TexturePool;

/// Resources shared across all passes within a frame.
pub struct GraphResources<'a> {
    pub device:    &'a wgpu::Device,
    pub queue:     &'a wgpu::Queue,
    pub pool:      &'a TexturePool,
    pub frame_buf: &'a wgpu::Buffer,
    /// The current swapchain texture view (output of last pass).
    pub surface:   &'a wgpu::TextureView,
}

type PassFn = Box<
    dyn for<'r> FnOnce(
        &'r mut wgpu::CommandEncoder,
        &'r GraphResources<'_>,
    ),
>;

struct Pass {
    name: &'static str,
    run:  PassFn,
}

/// Linear render graph.  Reset each frame.
pub struct RenderGraph {
    passes: Vec<Pass>,
}

impl RenderGraph {
    pub fn new() -> Self {
        Self { passes: Vec::with_capacity(16) }
    }

    /// Append a pass.  `f` will be called exactly once during
    /// [`RenderGraph::execute`].
    pub fn add_pass<F>(&mut self, name: &'static str, f: F)
    where
        F: for<'r> FnOnce(
                &'r mut wgpu::CommandEncoder,
                &'r GraphResources<'_>,
            ) + 'static,
    {
        self.passes.push(Pass { name, run: Box::new(f) });
    }

    /// Encode all passes into a single command buffer and submit.
    pub fn execute(
        self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        resources: &GraphResources<'_>,
    ) {
        let mut encoder =
            device.create_command_encoder(
                &wgpu::CommandEncoderDescriptor {
                    label: Some("voidborne-frame"),
                },
            );

        for pass in self.passes {
            tracing::trace!("render pass: {}", pass.name);
            (pass.run)(&mut encoder, resources);
        }

        queue.submit([encoder.finish()]);
    }
}

impl Default for RenderGraph {
    fn default() -> Self {
        Self::new()
    }
}
