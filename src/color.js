// Colour science for a six-ink E Ink Spectra 6 panel.
//
// Key idea: when the display dithers, what the eye sees from a normal viewing
// distance is the *average reflectance* of neighbouring pixels. Averages of ink
// colours are linear in linear-light RGB, so every colour the panel can show by
// dithering lies inside the convex hull of the six measured ink colours in that
// space. We (1) map the photo into that hull, then (2) dither.
import { INK_NAMES } from './config.js';

// ---------- sRGB <-> linear ----------
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
export const SRGB8_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB8_TO_LINEAR[i] = srgbToLinear(i / 255);

// Fast linear -> sRGB8 via a 4096-entry table.
const LIN_TO_SRGB8 = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) LIN_TO_SRGB8[i] = Math.round(linearToSrgb(i / 4096) * 255);
export function linearToSrgb8(c) {
  if (!(c > 0)) return 0;
  if (c >= 1) return 255;
  return LIN_TO_SRGB8[(c * 4096 + 0.5) | 0];
}

export function hexToRgb8(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---------- Oklab (Björn Ottosson) ----------
export function linearToOklab(r, g, b, out = [0, 0, 0]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return out;
}
export function oklabToLinear(L, a, b, out = [0, 0, 0]) {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  out[0] = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  out[1] = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  out[2] = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  return out;
}

export const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ---------- small vector helpers ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Faces of the convex hull of a handful of points (brute force; fine for 6 points).
export function convexHullFaces(points, eps = 1e-10) {
  const faces = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        let nrm = cross(sub(points[j], points[i]), sub(points[k], points[i]));
        const len = Math.hypot(...nrm);
        if (len < 1e-12) continue;
        nrm = nrm.map((v) => v / len);
        let d = dot(nrm, points[i]);
        let above = 0, below = 0;
        for (let m = 0; m < n; m++) {
          if (m === i || m === j || m === k) continue;
          const s = dot(nrm, points[m]) - d;
          if (s > eps) above++;
          else if (s < -eps) below++;
        }
        if (above && below) continue;
        if (above) { nrm = nrm.map((v) => -v); d = -d; }
        faces.push({ v: [i, j, k], n: nrm, d });
      }
    }
  }
  return faces;
}

// Build everything the dithering needs from the measured + device palettes.
export function buildPaletteModel(measuredHex, deviceHex) {
  const inks = INK_NAMES.map((name) => {
    const srgb8 = hexToRgb8(measuredHex[name]);
    const lin = srgb8.map((c) => SRGB8_TO_LINEAR[c]);
    return {
      name,
      measured: srgb8,
      device: hexToRgb8(deviceHex[name]),
      lin,
      lab: linearToOklab(lin[0], lin[1], lin[2]),
      lum: lum(lin[0], lin[1], lin[2]),
    };
  });
  // Preview colours: the measured inks as a viewer perceives them once the eye
  // has adapted to the paper white (white balance on the measured white).
  const Wl = inks[INK_NAMES.indexOf('white')].lin;
  for (const k of inks) k.preview = k.lin.map((v, c) => Math.round(linearToSrgb(Math.min(1, v / Wl[c])) * 255));
  const points = inks.map((k) => k.lin);
  const faces = convexHullFaces(points);
  const bi = INK_NAMES.indexOf('black');
  const wi = INK_NAMES.indexOf('white');
  const B = inks[bi].lin;
  const W = inks[wi].lin;
  if (!(inks[wi].lum > inks[bi].lum)) throw new Error('Palette: white must be lighter than black');

  // Flat typed arrays for the hot loops.
  const faceN = new Float64Array(faces.length * 3);
  const faceD = new Float64Array(faces.length);
  const faceV = new Int32Array(faces.length * 3);
  faces.forEach((f, idx) => {
    faceN.set(f.n, idx * 3);
    faceD[idx] = f.d;
    faceV.set(f.v, idx * 3);
  });
  const linFlat = new Float64Array(inks.length * 3);
  const labFlat = new Float64Array(inks.length * 3);
  inks.forEach((k, idx) => { linFlat.set(k.lin, idx * 3); labFlat.set(k.lab, idx * 3); });

  // Bounding box (per channel) of the inks, used to clamp diffused error.
  const lo = [0, 1, 2].map((c) => Math.min(...inks.map((k) => k.lin[c])));
  const hi = [0, 1, 2].map((c) => Math.max(...inks.map((k) => k.lin[c])));

  // Ink order by lightness (used by the blue-noise selector).
  const byLum = inks.map((k, i) => i).sort((a, b) => inks[a].lum - inks[b].lum);

  return {
    inks, faces, faceN, faceD, faceV, linFlat, labFlat,
    blackIdx: bi, whiteIdx: wi, B, W,
    lumB: inks[bi].lum, lumW: inks[wi].lum,
    lo, hi, byLum,
  };
}

// Map a target colour into the panel's achievable gamut:
// (1) per-channel black/white-point mapping, so image white -> paper white and
//     image black -> ink black (relative colorimetric with black point compensation),
// (2) if still outside the hull, desaturate at constant luminance toward the
//     black-white axis until it is inside.
export function makeGamutMapper(model, { anchorPull = 0.5 } = {}) {
  const { B, W, faceN, faceD, lumB, lumW } = model;
  const nf = faceD.length;
  const dB0 = B[0], dB1 = B[1], dB2 = B[2];
  const dW0 = W[0] - B[0], dW1 = W[1] - B[1], dW2 = W[2] - B[2];
  const lumSpan = lumW - lumB;
  return function map(r, g, b, out) {
    // (1) black/white point
    const pr = dB0 + r * dW0, pg = dB1 + g * dW1, pb = dB2 + b * dW2;
    // (2) hull. Out-of-gamut colours are moved toward a grey that sits partway
    // between "same luminance" and mid-grey: bright saturated colours then keep
    // more of their colour (slightly darker) instead of washing out to white.
    let y = (lum(pr, pg, pb) - lumB) / lumSpan;
    y = y < 0 ? 0 : y > 1 ? 1 : y;
    y += anchorPull * (0.5 - y);
    const ar = dB0 + y * dW0, ag = dB1 + y * dW1, ab = dB2 + y * dW2;
    const vr = pr - ar, vg = pg - ag, vb = pb - ab;
    let t = 1;
    for (let f = 0; f < nf; f++) {
      const nx = faceN[f * 3], ny = faceN[f * 3 + 1], nz = faceN[f * 3 + 2];
      const nv = nx * vr + ny * vg + nz * vb;
      if (nv > 1e-12) {
        const tf = (faceD[f] - (nx * ar + ny * ag + nz * ab)) / nv;
        if (tf < t) t = tf;
      }
    }
    if (t < 0) t = 0;
    out[0] = ar + t * vr;
    out[1] = ag + t * vg;
    out[2] = ab + t * vb;
    return out;
  };
}

// Express an in-gamut colour as a mix of inks (weights sum to 1):
// a grey on the black-white axis with the same luminance, plus the hull face
// hit by the ray from that grey through the colour. Neutral greys therefore use
// only black + white, and colours use only the few inks around their hue.
export function makeDecomposer(model) {
  const { B, W, faceN, faceD, faceV, linFlat, lumB, lumW, blackIdx, whiteIdx } = model;
  const nf = faceD.length;
  const dW0 = W[0] - B[0], dW1 = W[1] - B[1], dW2 = W[2] - B[2];
  const lumSpan = lumW - lumB;
  return function decompose(pr, pg, pb, w /* Float64Array(6), zeroed here */) {
    w.fill(0);
    let y = (lum(pr, pg, pb) - lumB) / lumSpan;
    y = y < 0 ? 0 : y > 1 ? 1 : y;
    const ar = B[0] + y * dW0, ag = B[1] + y * dW1, ab = B[2] + y * dW2;
    const vr = pr - ar, vg = pg - ag, vb = pb - ab;
    if (vr * vr + vg * vg + vb * vb < 1e-14) {
      w[blackIdx] = 1 - y;
      w[whiteIdx] += y;
      return w;
    }
    // Exit face of the ray a + t v (smallest positive t).
    let best = -1, tBest = Infinity;
    for (let f = 0; f < nf; f++) {
      const nx = faceN[f * 3], ny = faceN[f * 3 + 1], nz = faceN[f * 3 + 2];
      const nv = nx * vr + ny * vg + nz * vb;
      if (nv <= 1e-12) continue;
      const tf = (faceD[f] - (nx * ar + ny * ag + nz * ab)) / nv;
      if (tf > 1e-9 && tf < tBest - 1e-12) { tBest = tf; best = f; }
    }
    if (best < 0) { // numerically degenerate: fall back to grey only
      w[blackIdx] = 1 - y;
      w[whiteIdx] += y;
      return w;
    }
    const qr = ar + tBest * vr, qg = ag + tBest * vg, qb = ab + tBest * vb;
    // Barycentric coordinates of q in the face triangle.
    const i0 = faceV[best * 3], i1 = faceV[best * 3 + 1], i2 = faceV[best * 3 + 2];
    const p0 = i0 * 3, p1 = i1 * 3, p2 = i2 * 3;
    const e1r = linFlat[p1] - linFlat[p0], e1g = linFlat[p1 + 1] - linFlat[p0 + 1], e1b = linFlat[p1 + 2] - linFlat[p0 + 2];
    const e2r = linFlat[p2] - linFlat[p0], e2g = linFlat[p2 + 1] - linFlat[p0 + 1], e2b = linFlat[p2 + 2] - linFlat[p0 + 2];
    const qr0 = qr - linFlat[p0], qg0 = qg - linFlat[p0 + 1], qb0 = qb - linFlat[p0 + 2];
    const d11 = e1r * e1r + e1g * e1g + e1b * e1b;
    const d12 = e1r * e2r + e1g * e2g + e1b * e2b;
    const d22 = e2r * e2r + e2g * e2g + e2b * e2b;
    const dq1 = qr0 * e1r + qg0 * e1g + qb0 * e1b;
    const dq2 = qr0 * e2r + qg0 * e2g + qb0 * e2b;
    const den = d11 * d22 - d12 * d12;
    let b1 = (d22 * dq1 - d12 * dq2) / den;
    let b2 = (d11 * dq2 - d12 * dq1) / den;
    let b0 = 1 - b1 - b2;
    if (b0 < 0) b0 = 0;
    if (b1 < 0) b1 = 0;
    if (b2 < 0) b2 = 0;
    const sum = b0 + b1 + b2;
    b0 /= sum; b1 /= sum; b2 /= sum;
    const s = tBest >= 1 ? 1 / tBest : 1; // fraction of the face colour in the mix
    w[i0] += s * b0;
    w[i1] += s * b1;
    w[i2] += s * b2;
    w[blackIdx] += (1 - s) * (1 - y);
    w[whiteIdx] += (1 - s) * y;
    return w;
  };
}
