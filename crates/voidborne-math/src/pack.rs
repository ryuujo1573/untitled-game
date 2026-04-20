//! GPU-friendly packing helpers.
//!
//! The renderer stores normals in 16-bit octahedral form in the
//! g-buffer (RT1). These helpers produce the packed representation
//! CPU-side for mesh generation and verify round-trip fidelity in
//! tests.

use glam::{Vec2, Vec3};

/// Encode a unit normal to 2D octahedral mapping in `[-1, 1]²`.
#[inline]
pub fn oct_encode(n: Vec3) -> Vec2 {
    let n = n / (n.x.abs() + n.y.abs() + n.z.abs());
    if n.z >= 0.0 {
        Vec2::new(n.x, n.y)
    } else {
        let wrap = |v: f32, k: f32| (1.0 - v.abs()) * k.signum();
        Vec2::new(wrap(n.y, n.x), wrap(n.x, n.y))
    }
}

/// Decode an octahedral-packed direction back to a unit vector.
#[inline]
pub fn oct_decode(e: Vec2) -> Vec3 {
    let mut n = Vec3::new(e.x, e.y, 1.0 - e.x.abs() - e.y.abs());
    if n.z < 0.0 {
        let wrap = |v: f32, k: f32| (1.0 - v.abs()) * k.signum();
        n.x = wrap(e.y, e.x);
        n.y = wrap(e.x, e.y);
    }
    n.normalize()
}

/// Pack oct-encoded normal into 16-bit snorm pair.
#[inline]
pub fn oct_to_snorm16(e: Vec2) -> [i16; 2] {
    let to = |v: f32| (v.clamp(-1.0, 1.0) * 32767.0).round() as i16;
    [to(e.x), to(e.y)]
}

/// Inverse of [`oct_to_snorm16`].
#[inline]
pub fn oct_from_snorm16(v: [i16; 2]) -> Vec2 {
    Vec2::new(v[0] as f32 / 32767.0, v[1] as f32 / 32767.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(a: Vec3, b: Vec3, eps: f32) {
        let d = (a - b).length();
        assert!(d < eps, "{a:?} vs {b:?} delta {d}");
    }

    #[test]
    fn oct_roundtrip_cardinal_axes() {
        for n in [
            Vec3::X,
            Vec3::Y,
            Vec3::Z,
            Vec3::NEG_X,
            Vec3::NEG_Y,
            Vec3::NEG_Z,
        ] {
            let r = oct_decode(oct_encode(n));
            assert_close(r, n, 1e-4);
        }
    }

    #[test]
    fn oct_roundtrip_diagonals() {
        let samples = [
            Vec3::new(1.0, 1.0, 1.0).normalize(),
            Vec3::new(-1.0, 1.0, -1.0).normalize(),
            Vec3::new(0.3, -0.7, 0.5).normalize(),
        ];
        for n in samples {
            let r = oct_decode(oct_encode(n));
            assert_close(r, n, 1e-4);
        }
    }

    #[test]
    fn snorm16_roundtrip_within_tolerance() {
        let n = Vec3::new(0.6, -0.3, 0.5).normalize();
        let packed = oct_to_snorm16(oct_encode(n));
        let r = oct_decode(oct_from_snorm16(packed));
        assert_close(r, n, 2e-4);
    }
}
