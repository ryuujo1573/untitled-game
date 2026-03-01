import { mat4 } from "gl-matrix";

/**
 * A single clip-space plane.
 * A point p (in world space, w=1) is on the inside when A·px + B·py + C·pz + D >= 0.
 */
interface Plane {
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * View-frustum used for AABB chunk culling.
 *
 * Planes are extracted from the combined View-Projection matrix using the
 * Gribb / Hartmann method.  gl-matrix stores matrices column-major, so the
 * row layout is:
 *
 *   row 0 = [m[0], m[4], m[8],  m[12]]
 *   row 1 = [m[1], m[5], m[9],  m[13]]
 *   row 2 = [m[2], m[6], m[10], m[14]]
 *   row 3 = [m[3], m[7], m[11], m[15]]
 *
 * The 6 planes in world space:
 *   Left   = row3 + row0
 *   Right  = row3 − row0
 *   Bottom = row3 + row1
 *   Top    = row3 − row1
 *   Near   = row3 + row2
 *   Far    = row3 − row2
 *
 * Usage:
 *   frustum.update(vpMatrix);   // once per frame
 *   frustum.containsAABB(...);  // per chunk
 */
export class Frustum {
  private readonly planes: Plane[] = Array.from({ length: 6 }, () => ({
    a: 0,
    b: 0,
    c: 0,
    d: 0,
  }));

  /** Rebuild planes from the combined VP matrix (column-major). */
  update(vp: mat4): void {
    const m = vp;
    this.set(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]); // Left
    this.set(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]); // Right
    this.set(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]); // Bottom
    this.set(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]); // Top
    this.set(4, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]); // Near
    this.set(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]); // Far
  }

  private set(i: number, a: number, b: number, c: number, d: number): void {
    const p = this.planes[i];
    p.a = a;
    p.b = b;
    p.c = c;
    p.d = d;
  }

  /**
   * Returns true if the AABB may be visible (conservative – never culls
   * visible chunks, but may pass a few invisible corner cases).
   *
   * "p-vertex" test: for each plane, pick the AABB corner most aligned with
   * the plane normal (the corner that would be furthest inside).  If even
   * that corner is outside, the entire box is outside.
   */
  containsAABB(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): boolean {
    for (const p of this.planes) {
      const px = p.a >= 0 ? maxX : minX;
      const py = p.b >= 0 ? maxY : minY;
      const pz = p.c >= 0 ? maxZ : minZ;
      if (p.a * px + p.b * py + p.c * pz + p.d < 0) return false;
    }
    return true;
  }
}
