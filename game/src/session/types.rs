use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkSnapshotV1 {
    pub cx: i32,
    pub cz: i32,
    /// Raw block IDs, length must be 4096.
    pub blocks: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum GeneratorKind {
    #[serde(rename = "default_heightmap")]
    DefaultHeightmap { grid_size: i32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSnapshotV1 {
    pub generator: GeneratorKind,
    pub chunks: Vec<ChunkSnapshotV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSnapshotV1 {
    pub position: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub velocity: [f32; 3],
    pub on_ground: bool,
    pub selected_block_type: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentSnapshotV1 {
    pub world_time: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntitySnapshotV1 {
    pub id: String,
    pub kind: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameSaveV1 {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub world: WorldSnapshotV1,
    pub player: PlayerSnapshotV1,
    pub environment: EnvironmentSnapshotV1,
    pub entities: Vec<EntitySnapshotV1>,
    pub meta: SaveMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveSummary {
    pub id: String,
    pub name: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
