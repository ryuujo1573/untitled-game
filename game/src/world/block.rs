/// Integer IDs for each block type. Air = 0 means "empty".
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockType {
    Air = 0,
    Grass = 1,
    Dirt = 2,
    Stone = 3,
    CoalOre = 4,
    IronOre = 5,
    GoldOre = 6,
    DiamondOre = 7,
    EmeraldOre = 8,
    LapisOre = 9,
    RedstoneOre = 10,
    CopperOre = 11,
}

impl BlockType {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Grass,
            2 => Self::Dirt,
            3 => Self::Stone,
            4 => Self::CoalOre,
            5 => Self::IronOre,
            6 => Self::GoldOre,
            7 => Self::DiamondOre,
            8 => Self::EmeraldOre,
            9 => Self::LapisOre,
            10 => Self::RedstoneOre,
            11 => Self::CopperOre,
            _ => Self::Air,
        }
    }
}

/// Light emission level (0-15) per block type.
/// Index = BlockType discriminant. 0 = non-emissive.
pub const BLOCK_EMISSION: [u8; 12] = [
    0, // Air
    0, // Grass
    0, // Dirt
    0, // Stone
    0, // CoalOre
    0, // IronOre
    0, // GoldOre
    0, // DiamondOre
    0, // EmeraldOre
    0, // LapisOre
    9, // RedstoneOre — level 9, torch brightness
    0, // CopperOre
];

/// Returns true for solid blocks that fully block light.
#[inline]
pub fn is_opaque(t: BlockType) -> bool {
    t != BlockType::Air
}

/// Atlas tile index per face for each block type.
/// Face order: [+Y (top), -Y (bottom), +X, -X, +Z, -Z]
///
/// Atlas layout (12 tiles × 16 px):
///   0=grass_top  1=grass_side  2=dirt        3=stone
///   4=coal_ore   5=iron_ore    6=gold_ore    7=diamond_ore
///   8=emerald_ore 9=lapis_ore  10=redstone_ore 11=copper_ore
pub fn block_face_tiles(t: BlockType) -> [u8; 6] {
    match t {
        BlockType::Grass => [0, 2, 1, 1, 1, 1],
        BlockType::Dirt => [2; 6],
        BlockType::Stone => [3; 6],
        BlockType::CoalOre => [4; 6],
        BlockType::IronOre => [5; 6],
        BlockType::GoldOre => [6; 6],
        BlockType::DiamondOre => [7; 6],
        BlockType::EmeraldOre => [8; 6],
        BlockType::LapisOre => [9; 6],
        BlockType::RedstoneOre => [10; 6],
        BlockType::CopperOre => [11; 6],
        BlockType::Air => [0; 6],
    }
}
