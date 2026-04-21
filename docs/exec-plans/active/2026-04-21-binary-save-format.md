# Execution Plan: Binary Save Format (`.save` v1)

## Metadata

| Field             | Value                         |
| ----------------- | ----------------------------- |
| Plan ID           | 2026-04-21-binary-save-format |
| Owner             | agent                         |
| Status            | Not Started                   |
| Created           | 2026-04-21                    |
| Target completion | TBD                           |
| Related issue(s)  | —                             |

## Context

Current persistence lives in [game/src/session/types.rs](../../../game/src/session/types.rs) and
[game/src/session/codec.rs](../../../game/src/session/codec.rs). It relies on `serde` with a
JSON-flavored layout: chunks are `Vec<u8>` block IDs, entities are `serde_json::Value`, and the
environment snapshot only holds a single `world_time: f32`. This is convenient but:

- grows linearly with verbose text / tagged enums,
- can't carry per-voxel or per-column scalar fields (temperature, pressure, …),
- has no forward-compatibility story beyond `version: u32`,
- has no integrity check, no streaming layout, no per-section compression.

We need a dedicated binary container (`.save` — Voidborne Save) that is:

- stable across additive schema changes,
- chunk-aware (variable chunk counts, random-access friendly if needed later),
- able to store a standardized _environmental cell_ block alongside voxel blocks,
- extensible via a reserved/TLV area so new scalars don't require a new major version.

## Problem Statement

The engine has no binary save format. We cannot record environmental scalars
(temperature, air pressure, electric potential, magic mana, +reserved), nor can
we evolve the schema without rewriting `GameSaveV1` structurally. Saves also
lack integrity verification and per-chunk compression.

## Goals

- Define a versioned binary container `.save` with explicit endianness, alignment, and
  integrity checksum.
- Standardize a _chunk record_ and a co-located _environmental cell record_ so every
  chunk carries voxel + environment data with a uniform layout.
- Persist global world data: world time, generator kind + seed, tick count, calendar.
- Persist per-save settings (render distance at save time, difficulty, gameplay flags)
  separately from global world data.
- Persist player data: pose, velocity, selected hotbar, inventory stub.
- Persist entity records through a forward-compatible TLV list.
- Provide a migration path from the current `GameSaveV1` JSON snapshot.
- Keep encode/decode zero-copy-friendly (`bytemuck` POD blocks where possible).

## Non-Goals

- Multi-file region/anvil layout. V1 writes a single `.save` file per save.
- Networked / streaming deltas. V1 is whole-world snapshot only.
- Mod-defined custom environment scalars at runtime. V1 ships a fixed environment
  schema (with reserved bits) — dynamic schemas land in v2.
- Encryption or signing.
- Backwards-loading of pre-v1 JSON saves through the new loader at runtime (a one-shot
  external migration tool is enough).

## Constraints

- Architecture: save logic stays in `game/src/session/` (binary crate). Voxel and
  environment data types may surface in `voidborne-world` if reused; serialization code
  stays out of leaf crates per [ARCHITECTURE.md](../../../ARCHITECTURE.md).
- Endianness: little-endian on disk. Document explicitly.
- Alignment: records padded to 8 bytes so `bytemuck::cast_slice` is legal.
- All multi-byte numeric fields use fixed-width types (`u16`/`u32`/`u64`/`f32`/`f64`/`i32`).
- No external format dependency beyond what's already in the workspace
  (`serde` stays for in-memory DTOs; add `bytemuck`, `crc32fast`, optional `zstd`).

## File Layout (v1)

Multi-byte fields are little-endian.

```
+-----------------------------------------------------+
| FileHeader (64 B, fixed)                            |
|   magic[4]    = b"VSAV"                             |
|   version     : u16 = 1                             |
|   flags       : u16 (bit0 = zstd chunk payload)     |
|   header_crc  : u32                                 |
|   created_ms  : u64                                 |
|   updated_ms  : u64                                 |
|   section_count : u32                               |
|   reserved[28]                                      |
+-----------------------------------------------------+
| SectionTable (section_count × 24 B)                 |
|   kind   : u32  (see SectionKind)                   |
|   flags  : u32                                      |
|   offset : u64  (from file start)                   |
|   length : u64  (payload bytes)                     |
+-----------------------------------------------------+
| ... section payloads (in offset order) ...          |
+-----------------------------------------------------+
| TrailerFooter (16 B)                                |
|   file_crc32 : u32                                  |
|   pad[4]                                            |
|   magic_end  : u64 = 0x56534156454E4400 ("VSAVEND\0")|
+-----------------------------------------------------+
```

`SectionKind`:

| Value  | Name          | Contents                                           |
| ------ | ------------- | -------------------------------------------------- |
| 0x0001 | `META`        | Save id (UUID), display name, notes                |
| 0x0002 | `SETTINGS`    | Per-save runtime settings                          |
| 0x0003 | `GLOBALS`     | World time, tick, seed, generator tag              |
| 0x0004 | `PLAYER`      | Player pose + inventory stub                       |
| 0x0010 | `CHUNK_INDEX` | Array of chunk descriptors (coord, offset, length) |
| 0x0011 | `CHUNKS`      | Concatenated chunk payloads referenced by index    |
| 0x0020 | `ENTITIES`    | TLV list of entity records                         |
| 0xFFFF | `EXT_TLV`     | Forward-compat TLV bag for unknown fields          |

### Chunk record (in `CHUNKS`)

A chunk is a 16×128×16 column. Voxel and environment arrays share the same cell index
(`y*256 + z*16 + x`), giving 32768 cells.

```
ChunkHeader (32 B):
  magic[4]     = b"CHNK"
  cx : i32, cz : i32
  cells  : u32 = 32768
  voxel_bytes      : u32  (palette-encoded or raw)
  env_bytes        : u32  (always cells * 32 after zstd decompress)
  compressed_flags : u32  (bit0 voxel zstd, bit1 env zstd)

then:
  voxel_payload [voxel_bytes]
  env_payload   [env_bytes]
  pad to 8 B
```

### EnvironmentCell (32 B POD)

One per voxel cell, laid out for `#[repr(C)]` + `bytemuck::Pod`.

```
struct EnvironmentCell {
    temperature_c    : f32,   // °C
    air_pressure_kpa : f32,   // kPa
    electric_pot_v   : f32,   // Volts
    magic_mana       : u64,   // raw mana units
    reserved0        : u32,   // 32 bits reserved
    reserved1        : u32,   // 32 bits reserved
    reserved2        : u32,   // 32 bits reserved
}
// size = 4+4+4+8+4+4+4 = 32 bytes
```

The three `reserved` slots cover the requested "3×32 more reserved bits" and
are zero on write/read for v1. Future scalars claim bits here without changing
record size.

### Globals section

```
u64 world_seed
f64 world_time          // fractional day
u64 tick_count
u32 generator_id        // registry id of worldgen
u32 calendar_day
u32 calendar_year
u32 pad
```

### Settings section

```
u16 render_distance
u16 simulation_distance
u8  difficulty
u8  pad[3]
u32 gameplay_flags       // cheats, keep-inventory, hardcore, ...
u32 reserved[4]
```

### Player section

```
[f64; 3] position
f32      yaw, pitch
[f32; 3] velocity
u8       on_ground (0/1)
u8       selected_hotbar_slot
u16      health
u32      xp_level
u32      inventory_count
InventoryItem[ inventory_count ]
  {  u32 item_id, u16 count, u16 damage, u32 nbt_tlv_len, u8 nbt_tlv[...] }
```

### Entities section

Length-prefixed TLV list:

```
u32 entity_count
EntityRecord[entity_count]:
  u32 type_id
  u32 record_len
  u8  payload[record_len]   // per-type, versioned by type_id
```

### EXT_TLV section

Generic escape hatch: `{ u32 tag; u32 len; u8 data[len]; }*`. Unknown tags are
preserved on re-save.

## Task Breakdown

- [ ] **T1. Schema doc**: lift the tables above into `docs/design-docs/save-format-v1.md`
      with a "reserved fields ledger" for the 3×32 bits.
- [ ] **T2. Types crate module**: new `game/src/session/binary/` with: - `header.rs` — `FileHeader`, `SectionEntry`, `SectionKind` (POD + bytemuck). - `env.rs` — `EnvironmentCell` POD + unit tests for `size_of == 32`. - `chunk.rs` — `ChunkHeader`, voxel payload encoder (raw first, palette later). - `globals.rs`, `settings.rs`, `player.rs`, `entities.rs`.
- [ ] **T3. Writer**: `binary::write_save(path, &SaveView) -> io::Result<()>`.
      Streams sections, patches offsets, computes CRC32, writes trailer.
- [ ] **T4. Reader**: `binary::read_save(path) -> io::Result<SaveView>`.
      Validates magic + version + CRC, honours `EXT_TLV` preservation.
- [ ] **T5. SaveView**: runtime-facing DTO bridging `World`, `Camera`, `Physics`.
      Replace direct use of `GameSaveV1` in `app.rs`.
- [ ] **T6. Migration tool**: `cargo run -p voidborne -- migrate-save <in.json> <out.save>`
      that reads the legacy JSON through existing `GameSaveV1` and writes `.save`.
- [ ] **T7. Env data wiring**: add a per-column `EnvironmentGrid` in
      `voidborne-world` (dense `Box<[EnvironmentCell; 32768]>`). Default to
      NTP-ish values (15 °C, 101.325 kPa, 0 V, 0 mana) on generation.
- [ ] **T8. Round-trip tests**: property tests that write → read → compare for
      random worlds + env grids; fuzz truncated/bit-flipped files return `Err`.
- [ ] **T9. Integrate save/load hot path** behind a `binary_saves` feature flag;
      keep JSON path as fallback for one release.
- [ ] **T10. Remove JSON path** after one release, update trackers.

## Validation Plan

- Unit / integration:
  - `cargo test -p voidborne binary::` covering header CRC, section indexing,
    `EnvironmentCell` layout (`size_of`, `align_of`), chunk round-trip.
  - Golden file test: commit a tiny 1-chunk `.save` fixture under
    `tests/fixtures/` and assert byte-exact re-encode.
  - Fuzz: `cargo test --release` with a proptest generator producing random
    worlds, ensuring `read(write(x)) == x`.
- Manual / runtime:
  - Launch game, place blocks, quit, relaunch, confirm world + player pose + env
    grid restored.
  - Inspect `.save` with `hexdump`; verify magic `VSAV` and trailer `VSAVEND\0`.
- Regression:
  - Legacy JSON save → migrate → load path produces a world visually identical
    to the JSON loader.
  - `cargo clippy --workspace -- -D warnings`.

## Progress Log

### 2026-04-21 00:00

- Update: Plan drafted. Schema and section layout defined, tasks broken out.
- Evidence: this file.
- Next step: Await approval / owner assignment, then start T1 (design doc) and T2
  (type skeletons) in parallel.

## Decision Log

### 2026-04-21 00:00

- Decision: Single-file `.save` container with section table + trailer CRC.
- Why: Simpler than region files; random-access isn't needed at v1 scale;
  trailer CRC lets us detect truncation cheaply.
- Tradeoff: Whole-file rewrite on save. Acceptable for current world sizes;
  revisit when we move to streaming chunk I/O.

### 2026-04-21 00:01

- Decision: Environment scalars stored as a fixed 32-byte POD per voxel cell,
  with three `u32` reserved slots.
- Why: Matches the requested `{temperature f32, pressure f32, electric f32,
mana u64, 3×32 reserved}` shape exactly; keeps `bytemuck::Pod`; no alignment
  holes.
- Tradeoff: ~128 MiB of env data for a 4096-column world uncompressed. Mitigated
  by optional zstd per chunk (bit1 of `compressed_flags`).

### 2026-04-21 00:02

- Decision: Keep `serde` for TLV payloads that are still experimental (entities,
  NBT-like inventory); harden into POD once stable.
- Why: Lets gameplay iterate without blocking the binary base layout.
- Tradeoff: Mixed-mode encode. Confined to `EXT_TLV` and entity payloads.

## Risk And Rollback

- **Risk 1**: Schema drift between writer and reader during iteration.
  - Mitigation: version both the container (`FileHeader.version`) and each
    `SectionKind` payload (`payload_version: u16` leading every section).
  - Rollback: `binary_saves` cargo feature flag; flip off to restore JSON.
- **Risk 2**: Silent data loss when dropping unknown sections.
  - Mitigation: reader surfaces unknown `SectionKind`s into `EXT_TLV` and
    writer re-emits them.
- **Risk 3**: Environment grid memory blow-up on low-spec machines.
  - Mitigation: lazy-allocate `EnvironmentGrid` per loaded column; offer a
    "sparse" future variant (v2) if telemetry shows pressure.

## Completion Checklist

- [ ] Tasks complete
- [ ] Validation evidence captured
- [ ] Trackers updated
- [ ] Relevant docs updated
- [ ] Plan moved to completed
