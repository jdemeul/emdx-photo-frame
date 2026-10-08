// Per-photo tone adjustments, done in Oklab before dithering:
// gentle auto-levels, an S-curve for midtone contrast, an optional gamma and a
// saturation boost (Spectra 6 inks are muted, so photos look flat without it).
import { SRGB8_TO_LINEAR, linearToOklab, oklabToLinear, linearToSrgb8 } from './color.js';

// Symmetric S-curve on [0,1] that keeps 0, 0.5 and 1 fixed; k = 0 is identity.
export function sCurve(x, k) {
  if (k <= 0) return x;
  const u = 2 * x - 1;
  const g = (u * (1 + k)) / (1 + k * Math.abs(u));
  return 0.5 + 0.5 * g;
}

export function toneAdjust(rgb, width, height, opts = {}) {
  const { saturation = 1.3, contrast = 0.25, autoLevels = true, gamma = 1 } = opts;
  const n = width * height;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const Bc = new Float32Array(n);
  const lab = [0, 0, 0];
  const hist = new Uint32Array(1024);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    linearToOklab(SRGB8_TO_LINEAR[rgb[p]], SRGB8_TO_LINEAR[rgb[p + 1]], SRGB8_TO_LINEAR[rgb[p + 2]], lab);
    L[i] = lab[0]; A[i] = lab[1]; Bc[i] = lab[2];
    const bin = Math.min(1023, Math.max(0, (lab[0] * 1023) | 0));
    hist[bin]++;
  }

  // Auto-levels: stretch the 0.5–99.5 % lightness range, but never by more than 1.4x.
  let lo = 0, hi = 1;
  if (autoLevels) {
    const pct = (q) => {
      const target = q * n;
      let acc = 0;
      for (let b = 0; b < 1024; b++) { acc += hist[b]; if (acc >= target) return b / 1023; }
      return 1;
    };
    lo = Math.min(pct(0.005), 0.2);
    hi = Math.max(pct(0.995), 0.75);
  }
  const span = hi - lo;
  const maxGain = 1.4;
  const gain = Math.min(1 / span, maxGain);
  const mid = (lo + hi) / 2;
  const levels = autoLevels
    ? (1 / span <= maxGain ? (x) => (x - lo) / span : (x) => 0.5 + (x - mid) * gain)
    : (x) => x;

  const out = Buffer.allocUnsafe(n * 3);
  const lin = [0, 0, 0];
  const invGamma = 1 / gamma;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    let l = levels(L[i]);
    l = l < 0 ? 0 : l > 1 ? 1 : l;
    if (gamma !== 1) l = Math.pow(l, invGamma);
    l = sCurve(l, contrast);
    // Values pushed outside sRGB by the saturation boost are clipped per channel below;
    // the gamut mapper squeezes everything into the ink gamut afterwards anyway.
    oklabToLinear(l, A[i] * saturation, Bc[i] * saturation, lin);
    out[p] = linearToSrgb8(lin[0]);
    out[p + 1] = linearToSrgb8(lin[1]);
    out[p + 2] = linearToSrgb8(lin[2]);
  }
  return out;
}
