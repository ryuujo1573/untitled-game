export interface CloudMesh {
  positions: Float32Array;
  uvs: Float32Array;
  vertexCount: number;
}

export interface BuildCloudMeshOptions {
  radiusTiles: number;
  tileSize: number;
  y: number;
  seed: number;
  density?: number;
}

function hash2(x: number, z: number, seed: number): number {
  let h =
    (x * 374761393 + z * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

export function buildCloudMesh(
  opts: BuildCloudMeshOptions,
): CloudMesh {
  const density = opts.density ?? 0.55;
  const r = Math.max(2, Math.floor(opts.radiusTiles));
  const y = opts.y;
  const s = opts.tileSize;

  const positions: number[] = [];
  const uvs: number[] = [];

  const pushQuad = (x0: number, z0: number): void => {
    const x1 = x0 + s;
    const z1 = z0 + s;

    positions.push(
      x0,
      y,
      z0,
      x1,
      y,
      z0,
      x0,
      y,
      z1,

      x0,
      y,
      z1,
      x1,
      y,
      z0,
      x1,
      y,
      z1,
    );

    uvs.push(
      0,
      0,
      1,
      0,
      0,
      1,

      0,
      1,
      1,
      0,
      1,
      1,
    );
  };

  for (let tz = -r; tz <= r; tz++) {
    for (let tx = -r; tx <= r; tx++) {
      const edgeFade =
        Math.max(Math.abs(tx), Math.abs(tz)) / r;
      const threshold = density + edgeFade * 0.2;
      if (hash2(tx, tz, opts.seed) > threshold) continue;

      const x0 = tx * s;
      const z0 = tz * s;
      pushQuad(x0, z0);
    }
  }

  const pos = new Float32Array(positions);
  const tex = new Float32Array(uvs);
  return {
    positions: pos,
    uvs: tex,
    vertexCount: pos.length / 3,
  };
}
