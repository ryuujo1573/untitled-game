//! Input buffering, smoothing, and action mapping.
//!
//! # Architecture
//!
//! ```text
//!  OS / winit events                 Game-logic tick
//!  (any frequency)                   (once per frame)
//!
//!  DeviceEvent::MouseMotion          update_and_render()
//!        │                                 │
//!        ▼                                 ▼
//!  InputBuffer::push_mouse_delta()  InputBuffer::consume()
//!    (accumulates raw Δx, Δy)             │
//!                                   MouseSmoother::smooth()
//!                                    (EMA per-frame delta)
//!                                         │
//!                                   Camera::rotate(Δx, Δy)
//!                                         │
//!                                   push_frame_state() ──► Render thread
//! ```
//!
//! High-frequency devices (e.g. 1000 Hz mice) call `push_mouse_delta`
//! many times per rendered frame.  The accumulator sums those deltas so
//! the logic thread sees exactly one correctly-sized delta per tick —
//! independent of the reporting rate — and the EMA smoother removes
//! per-frame jitter without adding perceptible latency.

use std::collections::HashSet;

use winit::keyboard::KeyCode;

// ── Input buffer ──────────────────────────────────────────────────────────────

/// Accumulates raw mouse motion events between game-logic ticks.
///
/// Call [`push_mouse_delta`] from every `DeviceEvent::MouseMotion` (or
/// `WindowEvent::CursorMoved` delta).  Call [`consume`] once per frame
/// to obtain the total accumulated delta and reset the accumulator.
///
/// This decouples the event-delivery frequency (potentially 1000 Hz) from
/// the game-logic update rate without dropping any motion data.
pub struct InputBuffer {
    raw_dx: f32,
    raw_dy: f32,
}

impl InputBuffer {
    pub fn new() -> Self {
        Self {
            raw_dx: 0.0,
            raw_dy: 0.0,
        }
    }

    /// Push one raw mouse-motion event into the accumulator.
    ///
    /// Cheap: just two float additions.  Safe to call at 1000 Hz.
    #[inline]
    pub fn push_mouse_delta(&mut self, dx: f32, dy: f32) {
        self.raw_dx += dx;
        self.raw_dy += dy;
    }

    /// Drain the accumulator and return the total delta since the last call.
    ///
    /// Call once per game-logic tick.  Returns `(0.0, 0.0)` if no motion
    /// arrived since the previous consume.
    #[inline]
    pub fn consume(&mut self) -> (f32, f32) {
        let out = (self.raw_dx, self.raw_dy);
        self.raw_dx = 0.0;
        self.raw_dy = 0.0;
        out
    }
}

impl Default for InputBuffer {
    fn default() -> Self {
        Self::new()
    }
}

// ── Mouse smoother ────────────────────────────────────────────────────────────

/// Per-frame exponential moving average (EMA) smoother for mouse deltas.
///
/// Reduces frame-to-frame jitter caused by sub-pixel rounding, USB polling
/// variance, or input-event batching — while preserving responsiveness.
///
/// ## Tuning `alpha`
///
/// `alpha` ∈ (0, 1] is the weight given to the current frame's raw delta:
///
/// | alpha | character              |
/// |-------|------------------------|
/// | 1.0   | no smoothing           |
/// | 0.7   | slightly smoothed      |
/// | 0.5   | balanced (default)     |
/// | 0.3   | smooth but laggy       |
///
/// When the mouse is stationary the smoother decays toward zero over a
/// handful of frames, so there is no phantom drift on low-frequency devices.
///
/// ## Formula
///
/// ```text
/// smoothed_n = alpha * raw_n + (1 - alpha) * smoothed_{n-1}
/// ```
pub struct MouseSmoother {
    smoothed_dx: f32,
    smoothed_dy: f32,
    /// EMA weight for the current frame sample.  Clamped to `[0.01, 1.0]`.
    pub alpha: f32,
}

impl MouseSmoother {
    /// Create a new smoother with the given `alpha`.
    pub fn new(alpha: f32) -> Self {
        Self {
            smoothed_dx: 0.0,
            smoothed_dy: 0.0,
            alpha: alpha.clamp(0.01, 1.0),
        }
    }

    /// Feed the per-frame raw delta (from [`InputBuffer::consume`]) and
    /// return the EMA-smoothed delta to pass to `Camera::rotate`.
    ///
    /// When `raw_dx == 0 && raw_dy == 0` (no mouse motion this frame) the
    /// output decays toward zero, preventing drift on pauses.
    #[inline]
    pub fn smooth(&mut self, raw_dx: f32, raw_dy: f32) -> (f32, f32) {
        let a = self.alpha;
        self.smoothed_dx = a * raw_dx + (1.0 - a) * self.smoothed_dx;
        self.smoothed_dy = a * raw_dy + (1.0 - a) * self.smoothed_dy;
        (self.smoothed_dx, self.smoothed_dy)
    }
}

impl Default for MouseSmoother {
    fn default() -> Self {
        Self::new(0.5)
    }
}

// ── Action state ──────────────────────────────────────────────────────────────

/// Snapshot of named gameplay actions for the current frame.
///
/// Computed once per frame from the live key set, so the rest of the game
/// logic talks to semantic actions rather than raw `KeyCode`s.  Changing
/// a keybinding only requires updating [`ActionState::from_keys`].
#[derive(Default, Clone, Copy)]
pub struct ActionState {
    pub forward: bool,
    pub backward: bool,
    pub strafe_left: bool,
    pub strafe_right: bool,
    /// Jump (ground) or ascend (fly mode).
    pub jump_or_ascend: bool,
    /// Descend in fly mode.
    pub fly_descend: bool,
}

impl ActionState {
    /// Build an [`ActionState`] from the current live key set.
    pub fn from_keys(keys: &HashSet<KeyCode>) -> Self {
        Self {
            forward: keys.contains(&KeyCode::KeyW),
            backward: keys.contains(&KeyCode::KeyS),
            strafe_left: keys.contains(&KeyCode::KeyA),
            strafe_right: keys.contains(&KeyCode::KeyD),
            jump_or_ascend: keys.contains(&KeyCode::Space),
            fly_descend: keys.contains(&KeyCode::ShiftLeft) || keys.contains(&KeyCode::ShiftRight),
        }
    }
}
