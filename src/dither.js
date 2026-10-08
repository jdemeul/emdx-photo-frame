// Dithering to the six Spectra 6 inks.
//
// Two methods (both work on colours already mapped into the inks' gamut):
//  - "bluenoise" (default): every pixel draws one ink from its colour's exact
//    ink mix (see makeDecomposer), using a blue-noise threshold mask. Greys use
//    only black + white, skin uses white/red/yellow, and there is no error
//    propagation, so no worms, streaks or colour drift.
//  - "diffusion": classic serpentine error diffusion (Floyd-Steinberg, Stucki, ...)
//    in linear light with the nearest ink judged in Oklab. A touch crisper on fine
//    detail, but sprinkles stray colours ("confetti") into greys and skin.
import { SRGB8_TO_LINEAR, makeGamutMapper, makeDecomposer } from './color.js';

export const KERNELS = {
  'floyd-steinberg': { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  stucki: { div: 42, taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
  jarvis: { div: 48, taps: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
  sierra: { div: 32, taps: [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]] },
  // Atkinson spreads only 6/8 of the error: punchier, but clips shadows/highlights.
  atkinson: { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
};

// ---------- blue noise (void-and-cluster, Ulichney 1993) ----------
function mulberry32(seed) {
  return function rand() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let cachedMask = null;
export function blueNoiseMask(size = 64, seed = 7) {
  if (cachedMask && cachedMask.size === size) return cachedMask.mask;
  const N = size * size;
  const sigma = 1.5;
  const kern = new Float64Array(N);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const wx = Math.min(dx, size - dx), wy = Math.min(dy, size - dy);
      kern[dy * size + dx] = Math.exp(-(wx * wx + wy * wy) / (2 * sigma * sigma));
    }
  }
  const toggle = (E, pos, sign) => {
    const px = pos % size, py = (pos / size) | 0;
    for (let v = 0; v < size; v++) {
      const ky = ((v - py + size) % size) * size;
      const row = v * size;
      for (let u = 0; u < size; u++) E[row + u] += sign * kern[ky + ((u - px + size) % size)];
    }
  };
  const argExt = (E, P, want, max) => {
    let best = -1, bv = max ? -Infinity : Infinity;
    for (let i = 0; i < N; i++) {
      if (P[i] !== want) continue;
      if (max ? E[i] > bv : E[i] < bv) { bv = E[i]; best = i; }
    }
    return best;
  };

  const rand = mulberry32(seed);
  const proto = new Uint8Array(N);
  const E = new Float64Array(N);
  const n1 = Math.round(N * 0.1);
  for (let placed = 0; placed < n1;) {
    const pos = (rand() * N) | 0;
    if (!proto[pos]) { proto[pos] = 1; toggle(E, pos, 1); placed++; }
  }
  // Relax the initial pattern into a well-spread one.
  for (let iter = 0; iter < N; iter++) {
    const c = argExt(E, proto, 1, true);
    proto[c] = 0; toggle(E, c, -1);
    const v = argExt(E, proto, 0, false);
    if (v === c) { proto[c] = 1; toggle(E, c, 1); break; }
    proto[v] = 1; toggle(E, v, 1);
  }

  const rank = new Int32Array(N);
  // Phase 1: rank the initial ones by removing tightest clusters.
  {
    const P = proto.slice();
    const E1 = E.slice();
    for (let r = n1 - 1; r >= 0; r--) {
      const c = argExt(E1, P, 1, true);
      P[c] = 0; toggle(E1, c, -1);
      rank[c] = r;
    }
  }
  // Phase 2: fill voids up to half.
  const P = proto.slice();
  const E2 = E.slice();
  for (let r = n1; r < N / 2; r++) {
    const v = argExt(E2, P, 0, false);
    P[v] = 1; toggle(E2, v, 1);
    rank[v] = r;
  }
  // Phase 3: invert and rank the remaining minority pixels by tightest cluster.
  const Q = new Uint8Array(N);
  const E3 = new Float64Array(N);
  for (let i = 0; i < N; i++) if (!P[i]) { Q[i] = 1; toggle(E3, i, 1); }
  for (let r = N / 2; r < N; r++) {
    const c = argExt(E3, Q, 1, true);
    Q[c] = 0; toggle(E3, c, -1);
    rank[c] = r;
  }
  const mask = new Float32Array(N);
  for (let i = 0; i < N; i++) mask[i] = (rank[i] + 0.5) / N;
  cachedMask = { size, mask };
  return mask;
}

// ---------- main entry ----------
// rgb8: sRGB canvas (3 bytes/pixel). Returns one ink index per pixel.
export function dither(rgb8, width, height, model, opts = {}) {
  const {
    method = 'bluenoise',
    kernel = 'floyd-steinberg',
    serpentine = true,
    gamutOpts,
  } = opts;
  const gamut = makeGamutMapper(model, gamutOpts);
  const nInks = model.inks.length;
  const out = new Uint8Array(width * height);
  const target = [0, 0, 0];

  if (method === 'bluenoise') {
    // Each pixel draws one ink from its colour's exact ink mix, using a blue-noise
    // threshold so the chosen inks are spread evenly. Average colour is exact.
    const decompose = makeDecomposer(model);
    const w = new Float64Array(nInks);
    const size = 64;
    const mask = blueNoiseMask(size);
    const order = model.byLum;
    for (let y = 0; y < height; y++) {
      const mrow = (y % size) * size;
      for (let x = 0; x < width; x++) {
        const i = y * width + x, p = i * 3;
        gamut(SRGB8_TO_LINEAR[rgb8[p]], SRGB8_TO_LINEAR[rgb8[p + 1]], SRGB8_TO_LINEAR[rgb8[p + 2]], target);
        decompose(target[0], target[1], target[2], w);
        const t = mask[mrow + (x % size)];
        let acc = 0, pick = order[order.length - 1];
        for (let k = 0; k < order.length; k++) {
          acc += w[order[k]];
          if (t < acc) { pick = order[k]; break; }
        }
        out[i] = pick;
      }
    }
    return out;
  }

  // Classic error diffusion in linear light; nearest ink judged in Oklab.
  const kern = KERNELS[kernel];
  if (!kern) throw new Error(`Unknown dither kernel "${kernel}"`);
  const pad = 2;
  const stride = (width + 2 * pad) * 3;
  const rows = [new Float32Array(stride), new Float32Array(stride), new Float32Array(stride)];
  const { linFlat, labFlat, lo, hi } = model;
  const margin = 0.12; // bound the accumulated error so it cannot run away
  const lo0 = lo[0] - margin, lo1 = lo[1] - margin, lo2 = lo[2] - margin;
  const hi0 = hi[0] + margin, hi1 = hi[1] + margin, hi2 = hi[2] + margin;
  const taps = kern.taps.map(([dx, dy, wt]) => [dx, dy, wt / kern.div]);

  for (let y = 0; y < height; y++) {
    const rev = serpentine && (y & 1) === 1;
    const err0 = rows[0];
    for (let step = 0; step < width; step++) {
      const x = rev ? width - 1 - step : step;
      const i = y * width + x, p = i * 3;
      gamut(SRGB8_TO_LINEAR[rgb8[p]], SRGB8_TO_LINEAR[rgb8[p + 1]], SRGB8_TO_LINEAR[rgb8[p + 2]], target);
      const e = (x + pad) * 3;
      let r = target[0] + err0[e], g = target[1] + err0[e + 1], b = target[2] + err0[e + 2];
      r = r < lo0 ? lo0 : r > hi0 ? hi0 : r;
      g = g < lo1 ? lo1 : g > hi1 ? hi1 : g;
      b = b < lo2 ? lo2 : b > hi2 ? hi2 : b;

      const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
      const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
      const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
      let best = 0, bd = Infinity;
      for (let k = 0; k < nInks; k++) {
        const dl = L - labFlat[k * 3], da = A - labFlat[k * 3 + 1], db = B - labFlat[k * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = k; }
      }
      out[i] = best;

      const er = r - linFlat[best * 3], eg = g - linFlat[best * 3 + 1], eb = b - linFlat[best * 3 + 2];
      for (let t = 0; t < taps.length; t++) {
        const dx = rev ? -taps[t][0] : taps[t][0];
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        const row = rows[taps[t][1]];
        const q = (xx + pad) * 3, wt = taps[t][2];
        row[q] += er * wt; row[q + 1] += eg * wt; row[q + 2] += eb * wt;
      }
    }
    const first = rows.shift();
    first.fill(0);
    rows.push(first);
  }
  return out;
}

export function indicesToRgb(indices, colors) {
  const out = Buffer.allocUnsafe(indices.length * 3);
  for (let i = 0, p = 0; i < indices.length; i++, p += 3) {
    const c = colors[indices[i]];
    out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2];
  }
  return out;
}
