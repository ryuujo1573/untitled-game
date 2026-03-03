export function generateDefaultSkyboxEquirect(
  width: number,
  height: number,
): Uint8ClampedArray {
  const w = Math.max(2, Math.floor(width));
  const h = Math.max(2, Math.floor(height));
  const out = new Uint8ClampedArray(w * h * 4);

  const clamp01 = (v: number) =>
    Math.max(0, Math.min(1, v));
  const mix = (a: number, b: number, t: number) =>
    a + (b - a) * t;

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const t = clamp01(v ** 1.35);

    // Top to bottom gradient (deep azure to pale near horizon).
    let r = mix(18, 126, t);
    let g = mix(38, 174, t);
    let b = mix(82, 236, t);

    // Bright horizontal horizon border around v = 0.5.
    const horizonBand = Math.exp(
      -(((v - 0.5) / 0.02) ** 2.0),
    );
    r += horizonBand * 52;
    g += horizonBand * 54;
    b += horizonBand * 58;

    // Soft dusk haze below horizon to avoid harsh cutoff.
    const haze = clamp01((v - 0.5) / 0.25);
    r = mix(r, 74, haze * 0.35);
    g = mix(g, 98, haze * 0.35);
    b = mix(b, 128, haze * 0.35);

    for (let x = 0; x < w; x++) {
      // Use periodic theta-based modulation (2π-periodic) so x=0 and x=w-1
      // match exactly, preventing a visible seam at equirect wrap.
      const u = x / (w - 1);
      const theta = u * Math.PI * 2.0;
      const cloudWaveA = Math.cos(theta * 3.0 + v * 5.6);
      const cloudWaveB = Math.cos(theta * 5.0 - v * 3.3);
      const cloudField =
        (cloudWaveA * 0.6 + cloudWaveB * 0.4) * 0.5 + 0.5;
      const cloudBand = Math.exp(
        -(((v - 0.43) / 0.12) ** 2.0),
      );
      const cloudMask =
        clamp01((cloudField - 0.62) * 2.3) * cloudBand;

      // Subtle sun glow near one azimuth for depth without introducing seams.
      const sunTheta = Math.PI * 0.1;
      const dTheta = Math.acos(
        Math.max(
          -1,
          Math.min(1, Math.cos(theta - sunTheta)),
        ),
      );
      const sunGlow =
        Math.exp(-((dTheta / 0.22) ** 2.0)) *
        Math.exp(-(((v - 0.47) / 0.09) ** 2.0));

      const rr = Math.max(
        0,
        Math.min(255, r + cloudMask * 12 + sunGlow * 35),
      );
      const gg = Math.max(
        0,
        Math.min(255, g + cloudMask * 12 + sunGlow * 28),
      );
      const bb = Math.max(
        0,
        Math.min(255, b + cloudMask * 14 + sunGlow * 18),
      );

      const i = (y * w + x) * 4;
      out[i] = rr;
      out[i + 1] = gg;
      out[i + 2] = bb;
      out[i + 3] = 255;
    }
  }

  return out;
}
