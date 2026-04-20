use glam::Vec3;

use crate::world::block::BlockType;
use crate::world::World;

pub struct RayHit {
    pub bx: i32,
    pub by: i32,
    pub bz: i32,
    /// Face normal (one of the 6 unit axis directions).
    pub nx: i32,
    pub ny: i32,
    pub nz: i32,
}

/// DDA (Digital Differential Analyser) voxel ray
/// traversal. Steps one block boundary at a time,
/// always crossing the nearest axis-aligned boundary
/// next. O(n) in blocks traversed, never misses.
pub fn raycast(
    origin: Vec3,
    direction: Vec3,
    world: &World,
    max_dist: f32,
) -> Option<RayHit> {
    let dir = direction.normalize();

    let mut bx = origin.x.floor() as i32;
    let mut by = origin.y.floor() as i32;
    let mut bz = origin.z.floor() as i32;

    let dx = dir.x;
    let dy = dir.y;
    let dz = dir.z;

    let sx = if dx >= 0.0 { 1i32 } else { -1 };
    let sy = if dy >= 0.0 { 1i32 } else { -1 };
    let sz = if dz >= 0.0 { 1i32 } else { -1 };

    let t_delta_x = (1.0 / dx).abs();
    let t_delta_y = (1.0 / dy).abs();
    let t_delta_z = (1.0 / dz).abs();

    let mut tmx = if dx == 0.0 {
        f32::INFINITY
    } else if dx > 0.0 {
        (bx as f32 + 1.0 - origin.x) * t_delta_x
    } else {
        (origin.x - bx as f32) * t_delta_x
    };
    let mut tmy = if dy == 0.0 {
        f32::INFINITY
    } else if dy > 0.0 {
        (by as f32 + 1.0 - origin.y) * t_delta_y
    } else {
        (origin.y - by as f32) * t_delta_y
    };
    let mut tmz = if dz == 0.0 {
        f32::INFINITY
    } else if dz > 0.0 {
        (bz as f32 + 1.0 - origin.z) * t_delta_z
    } else {
        (origin.z - bz as f32) * t_delta_z
    };

    let mut nx = 0i32;
    let mut ny = 0i32;
    let mut nz = 0i32;

    while tmx.min(tmy).min(tmz) < max_dist {
        if tmx < tmy && tmx < tmz {
            bx += sx;
            nx = -sx;
            ny = 0;
            nz = 0;
            tmx += t_delta_x;
        } else if tmy < tmz {
            by += sy;
            nx = 0;
            ny = -sy;
            nz = 0;
            tmy += t_delta_y;
        } else {
            bz += sz;
            nx = 0;
            ny = 0;
            nz = -sz;
            tmz += t_delta_z;
        }

        if world.get_block(bx, by, bz) != BlockType::Air
        {
            return Some(RayHit {
                bx,
                by,
                bz,
                nx,
                ny,
                nz,
            });
        }
    }

    None
}
