//! voidborne-ecs — thin bevy_ecs wrapper.
//!
//! Provides a re-export of `bevy_ecs`, named schedule labels
//! for the simulation loop, and a convenience `AppSchedules`
//! type for building the per-frame execution graph.
//!
//! The server and client binaries both use these schedules so
//! that plugins (mods) can hook into a single, consistent API.

pub use bevy_ecs;
pub use bevy_ecs::prelude::*;

pub mod schedule;

pub use schedule::{GameSchedule, PostGameSchedule, PreGameSchedule, RenderSchedule};
