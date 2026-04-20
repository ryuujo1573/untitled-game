//! Block-state model: registry-driven block types and their
//! properties.
//!
//! In this new model each block is identified by a `BlockState`
//! which is a `RawId` (index into the block registry) plus up to
//! 16 bits of property state (facing, waterlogged, half, …).
//! The registry is global-static and must be populated during the
//! mod-load "Register" phase, then frozen before any world code runs.

use std::sync::OnceLock;

pub use voidborne_registry::RawId;
use voidborne_registry::{Registry, TagMap};
use voidborne_util::Ident;

// ── BlockState ────────────────────────────────────────

/// A block state = registry entry + up to 16 property bits.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct BlockState {
    /// Which entry in the block registry.
    pub id: RawId,
    /// Property bitmask.  Layout is block-type-specific;
    /// `0` is always the default state.
    pub props: u16,
}

impl BlockState {
    pub const AIR: BlockState = BlockState {
        id: RawId(0),
        props: 0,
    };
}

// ── BlockProperties ───────────────────────────────────

/// Metadata stored in the block registry for each block type.
#[derive(Clone, Debug)]
pub struct BlockProperties {
    /// Human-readable name (`"Grass Block"`).
    pub display_name: String,
    /// Blocks light fully (used by light engine).
    pub opaque: bool,
    /// Block-light emission 0–15.
    pub emission: u8,
    /// Collision and selection present.
    pub has_collision: bool,
    /// Atlas tile indices for each face [+Y, -Y, +X, -X, +Z, -Z].
    pub face_tiles: [u32; 6],
}

impl BlockProperties {
    pub fn new(name: impl Into<String>, face_tiles: [u32; 6]) -> Self {
        Self {
            display_name: name.into(),
            opaque: true,
            emission: 0,
            has_collision: true,
            face_tiles,
        }
    }

    pub fn with_emission(mut self, level: u8) -> Self {
        self.emission = level;
        self
    }

    pub fn with_opaque(mut self, opaque: bool) -> Self {
        self.opaque = opaque;
        self
    }
}

// ── Global block registry ─────────────────────────────

pub struct BlockRegistry {
    pub registry: Registry<BlockProperties>,
    pub tags: TagMap<BlockProperties>,
}

impl BlockRegistry {
    fn new() -> Self {
        let mut reg = Registry::new("block");
        let mut tags = TagMap::new("block");

        // Reserve index 0 for Air unconditionally.
        let _air_id = reg
            .register(
                "voidborne:air".parse().unwrap(),
                BlockProperties {
                    display_name: "Air".into(),
                    opaque: false,
                    emission: 0,
                    has_collision: false,
                    face_tiles: [0; 6],
                },
            )
            .expect("air registration failed");

        // ── Vanilla baseline blocks ───────────────────
        macro_rules! solid {
            ($id:literal, $name:literal, $tiles:expr) => {{
                let raw = reg
                    .register(
                        $id.parse().unwrap(),
                        BlockProperties::new($name, $tiles),
                    )
                    .expect(concat!("registration failed: ", $id));
                raw
            }};
        }

        let _grass = solid!("voidborne:grass_block", "Grass Block",
            [0, 2, 1, 1, 1, 1]);  // top=grass, bottom=dirt, sides=grass_side
        let _dirt = solid!("voidborne:dirt", "Dirt", [2; 6]);
        let _stone = solid!("voidborne:stone", "Stone", [3; 6]);

        let coal_ore = solid!("voidborne:coal_ore", "Coal Ore", [4; 6]);
        let iron_ore = solid!("voidborne:iron_ore", "Iron Ore", [5; 6]);
        let gold_ore = solid!("voidborne:gold_ore", "Gold Ore", [6; 6]);
        let diamond_ore = solid!("voidborne:diamond_ore", "Diamond Ore", [7; 6]);
        let emerald_ore = solid!("voidborne:emerald_ore", "Emerald Ore", [8; 6]);
        let lapis_ore = solid!("voidborne:lapis_ore", "Lapis Ore", [9; 6]);
        let copper_ore = solid!("voidborne:copper_ore", "Copper Ore", [11; 6]);

        // Redstone ore is emissive.
        let redstone_id: RawId = reg
            .register(
                "voidborne:redstone_ore".parse().unwrap(),
                BlockProperties::new("Redstone Ore", [10; 6])
                    .with_emission(9),
            )
            .expect("redstone registration failed");

        // Tags
        let ores_tag: Ident = "voidborne:ores".parse().unwrap();
        for &ore in &[
            coal_ore, iron_ore, gold_ore, diamond_ore,
            emerald_ore, lapis_ore, copper_ore, redstone_id,
        ] {
            tags.add(ores_tag.clone(), ore).unwrap();
        }

        reg.freeze();
        tags.freeze();

        Self {
            registry: reg,
            tags,
        }
    }

    /// Look up properties by `RawId` (panics if the registry is
    /// not yet populated — only valid after freeze).
    #[inline]
    pub fn props(&self, id: RawId) -> Option<&BlockProperties> {
        self.registry.get(id)
    }

    #[inline]
    pub fn air_id(&self) -> RawId {
        RawId(0)
    }

    pub fn is_air(&self, state: BlockState) -> bool {
        state.id == self.air_id()
    }

    pub fn is_opaque(&self, state: BlockState) -> bool {
        self.props(state.id)
            .map(|p| p.opaque)
            .unwrap_or(false)
    }

    pub fn emission(&self, state: BlockState) -> u8 {
        self.props(state.id).map(|p| p.emission).unwrap_or(0)
    }
}

static BLOCK_REGISTRY: OnceLock<BlockRegistry> = OnceLock::new();

/// Access the global block registry (populated at startup).
///
/// Returns `None` before first call to `init_block_registry`.
pub fn block_registry() -> &'static BlockRegistry {
    BLOCK_REGISTRY.get_or_init(BlockRegistry::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn air_is_index_0_and_non_opaque() {
        let reg = block_registry();
        let air = BlockState::AIR;
        assert!(!reg.is_opaque(air));
        assert_eq!(reg.air_id().raw(), 0);
    }

    #[test]
    fn ores_tag_has_expected_count() {
        let reg = block_registry();
        let tag: Ident = "voidborne:ores".parse().unwrap();
        assert_eq!(reg.tags.members(&tag).len(), 8);
    }

    #[test]
    fn redstone_ore_emits_light() {
        let reg = block_registry();
        let id = reg
            .registry
            .raw_of(&"voidborne:redstone_ore".parse().unwrap())
            .unwrap();
        let state = BlockState { id, props: 0 };
        assert_eq!(reg.emission(state), 9);
    }
}
