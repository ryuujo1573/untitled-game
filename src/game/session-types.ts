export interface ChunkSnapshotV1 {
  cx: number;
  cz: number;
  blocks: Uint8Array;
}

export interface WorldSnapshotV1 {
  generator: {
    kind: "default_heightmap";
    gridSize: number;
  };
  chunks: ChunkSnapshotV1[];
}

export interface PlayerSnapshotV1 {
  position: [number, number, number];
  yaw: number;
  pitch: number;
  velocity: [number, number, number];
  onGround: boolean;
  selectedBlockType: number;
}

export interface EnvironmentSnapshotV1 {
  worldTime: number;
}

export interface EntitySnapshotV1 {
  id: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface GameSaveV1 {
  version: 1;
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  world: WorldSnapshotV1;
  player: PlayerSnapshotV1;
  environment: EnvironmentSnapshotV1;
  entities: EntitySnapshotV1[];
  meta: { notes?: string };
}

export interface SaveSummary {
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
}
