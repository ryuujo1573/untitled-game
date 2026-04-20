use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::engine::camera::Camera;
use crate::engine::physics::Physics;
use crate::session::types::{
    ChunkSnapshotV1, EnvironmentSnapshotV1,
    GameSaveV1, GeneratorKind, PlayerSnapshotV1,
    SaveMeta, WorldSnapshotV1,
};
use crate::world::block::BlockType;
use crate::world::World;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Create a fresh save from generated terrain.
pub fn create_generated_save(
    name: &str,
    grid_size: i32,
) -> GameSaveV1 {
    let mut world = World::new();
    world.generate(grid_size);
    let world_snap = world_to_snapshot(&world);

    GameSaveV1 {
        version: 1,
        id: Uuid::new_v4().to_string(),
        name: name.to_owned(),
        created_at_ms: now_ms(),
        updated_at_ms: now_ms(),
        world: world_snap,
        player: PlayerSnapshotV1 {
            position: [32.0, 20.0, 32.0],
            yaw: 0.0,
            pitch: -0.3,
            velocity: [0.0; 3],
            on_ground: false,
            selected_block_type: BlockType::Dirt as u8,
        },
        environment: EnvironmentSnapshotV1 {
            world_time: 0.25,
        },
        entities: vec![],
        meta: SaveMeta { notes: None },
    }
}

/// Capture current runtime state into a save.
pub fn capture_save(
    save_id: &str,
    name: &str,
    created_at_ms: u64,
    world: &World,
    camera: &Camera,
    physics: &Physics,
    selected_block: BlockType,
    world_time: f32,
) -> GameSaveV1 {
    let pose = camera.get_pose();
    let pstate = physics.get_state();
    GameSaveV1 {
        version: 1,
        id: save_id.to_owned(),
        name: name.to_owned(),
        created_at_ms,
        updated_at_ms: now_ms(),
        world: world_to_snapshot(world),
        player: PlayerSnapshotV1 {
            position: pose.position,
            yaw: pose.yaw,
            pitch: pose.pitch,
            velocity: pstate.velocity,
            on_ground: pstate.on_ground,
            selected_block_type: selected_block as u8,
        },
        environment: EnvironmentSnapshotV1 {
            world_time,
        },
        entities: vec![],
        meta: SaveMeta { notes: None },
    }
}

/// Hydrate runtime state from a save.
pub fn hydrate_save(
    save: &GameSaveV1,
) -> (World, Camera, Physics) {
    let world = world_from_snapshot(&save.world);
    let mut camera = Camera::new();
    camera.position =
        glam::Vec3::from(save.player.position);
    camera.yaw = save.player.yaw;
    camera.pitch = save.player.pitch;

    let mut physics = Physics::new(&camera);
    physics.set_state(
        &crate::engine::physics::PhysicsState {
            velocity: save.player.velocity,
            on_ground: save.player.on_ground,
        },
        &camera,
    );

    (world, camera, physics)
}

// ── Conversion helpers ────────────────────────────────

fn world_to_snapshot(world: &World) -> WorldSnapshotV1 {
    let snap = world.to_snapshot();
    WorldSnapshotV1 {
        generator: GeneratorKind::DefaultHeightmap {
            grid_size: snap.grid_size,
        },
        chunks: snap
            .chunks
            .into_iter()
            .map(|c| ChunkSnapshotV1 {
                cx: c.cx,
                cz: c.cz,
                blocks: c.blocks,
            })
            .collect(),
    }
}

fn world_from_snapshot(
    snap: &WorldSnapshotV1,
) -> World {
    use crate::world::chunk::{
        Chunk, ChunkSnapshot,
    };
    use crate::world::WorldSnapshot;

    let grid_size = match &snap.generator {
        GeneratorKind::DefaultHeightmap {
            grid_size,
        } => *grid_size,
    };

    let ws = WorldSnapshot {
        grid_size,
        chunks: snap
            .chunks
            .iter()
            .map(|c| ChunkSnapshot {
                cx: c.cx,
                cz: c.cz,
                blocks: c.blocks.clone(),
            })
            .collect(),
    };
    World::from_snapshot(ws)
}
