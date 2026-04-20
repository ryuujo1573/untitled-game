//! Named schedule labels for the voidborne simulation loop.
//!
//! Execution order within a single frame / server tick:
//!
//! ```text
//!  ┌──────────────────┐
//!  │  PreGameSchedule │  Input, event flush, spawn/despawn
//!  └────────┬─────────┘
//!           ▼
//!  ┌──────────────────┐
//!  │   GameSchedule   │  Simulation: physics, AI, networks,
//!  └────────┬─────────┘  tile entities, fluid ticks …
//!           ▼
//!  ┌──────────────────┐
//!  │ PostGameSchedule │  Post-sim: light propagation, chunk
//!  └────────┬─────────┘  mesh dirty-marking, net sync
//!           ▼
//!  ┌──────────────────┐
//!  │  RenderSchedule  │  (client only) extract + draw calls
//!  └──────────────────┘
//! ```

use bevy_ecs::schedule::ScheduleLabel;

/// Input handling, event clearing, spawn/despawn queues.
#[derive(Debug, Clone, PartialEq, Eq, Hash, ScheduleLabel)]
pub struct PreGameSchedule;

/// Main simulation: physics, AI, energy/fluid/mana ticks.
#[derive(Debug, Clone, PartialEq, Eq, Hash, ScheduleLabel)]
pub struct GameSchedule;

/// Post-simulation: light propagation, meshing marks, net sync.
#[derive(Debug, Clone, PartialEq, Eq, Hash, ScheduleLabel)]
pub struct PostGameSchedule;

/// Rendering extract + command recording (client-side only).
#[derive(Debug, Clone, PartialEq, Eq, Hash, ScheduleLabel)]
pub struct RenderSchedule;
