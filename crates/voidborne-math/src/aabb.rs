//! Axis-aligned bounding box (f32).

use glam::Vec3;

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

#[derive(Copy, Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    #[inline]
    pub fn new(min: Vec3, max: Vec3) -> Self {
        Self { min, max }
    }

    #[inline]
    pub fn from_center_size(center: Vec3, size: Vec3) -> Self {
        let half = size * 0.5;
        Self {
            min: center - half,
            max: center + half,
        }
    }

    #[inline]
    pub fn extents(self) -> Vec3 {
        self.max - self.min
    }

    #[inline]
    pub fn center(self) -> Vec3 {
        (self.min + self.max) * 0.5
    }

    /// Expand this box by `amount` on every axis (negative shrinks).
    #[inline]
    pub fn expanded(self, amount: Vec3) -> Self {
        Self {
            min: self.min - amount,
            max: self.max + amount,
        }
    }

    #[inline]
    pub fn intersects(self, other: Aabb) -> bool {
        self.min.x < other.max.x
            && self.max.x > other.min.x
            && self.min.y < other.max.y
            && self.max.y > other.min.y
            && self.min.z < other.max.z
            && self.max.z > other.min.z
    }

    #[inline]
    pub fn contains_point(self, p: Vec3) -> bool {
        (self.min.cmple(p) & self.max.cmpge(p)).all()
    }

    /// Union with another AABB.
    #[inline]
    pub fn union(self, other: Aabb) -> Aabb {
        Aabb {
            min: self.min.min(other.min),
            max: self.max.max(other.max),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intersect_touching_is_false() {
        let a = Aabb::new(Vec3::ZERO, Vec3::ONE);
        let b = Aabb::new(Vec3::new(1.0, 0.0, 0.0), Vec3::new(2.0, 1.0, 1.0));
        assert!(!a.intersects(b));
    }

    #[test]
    fn intersect_overlapping_is_true() {
        let a = Aabb::new(Vec3::ZERO, Vec3::ONE);
        let b = Aabb::new(Vec3::splat(0.5), Vec3::splat(1.5));
        assert!(a.intersects(b));
    }

    #[test]
    fn from_center_size_is_symmetric() {
        let a = Aabb::from_center_size(Vec3::ZERO, Vec3::splat(2.0));
        assert_eq!(a.min, Vec3::splat(-1.0));
        assert_eq!(a.max, Vec3::splat(1.0));
        assert_eq!(a.center(), Vec3::ZERO);
    }
}
