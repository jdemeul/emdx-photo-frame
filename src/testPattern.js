// Calibration image: orientation, the six inks, our dithering vs the display's
// own processing, and 1-pixel patterns that reveal any rescaling.
import sharp from 'sharp';
import { dither, indicesToRgb } from './dither.js';
import { linearToSrgb, oklabToLinear } from './color.js';

function fill(buf, W, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = (y * W + x) * 3;
      buf[p] = rgb[0]; buf[p + 1] = rgb[1]; buf[p + 2] = rgb[2];
    }
  }
}

// Smooth test bands (sRGB): grey ramp, hue sweep, and a lightness x hue field.
function bands(w, h) {
  const out = Buffer.alloc(w * h * 3);
  const hb = Math.floor(h / 3);
  const lin = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      let r, g, b;
      if (y < hb) {
        r = g = b = Math.round(t * 255);
      } else {
        const hue = t * 2 * Math.PI;
        const L = y < 2 * hb ? 0.72 : 0.92 - 0.75 * ((y - 2 * hb) / (h - 2 * hb));
        const C = y < 2 * hb ? 0.16 : 0.12;
        oklabToLinear(L, C * Math.cos(hue), C * Math.sin(hue), lin);
        [r, g, b] = lin.map((v) => Math.round(linearToSrgb(Math.max(0, Math.min(1, v))) * 255));
      }
      const p = (y * w + x) * 3;
      out[p] = r; out[p + 1] = g; out[p + 2] = b;
    }
  }
  return out;
}

function svgText(W, H, items) {
  const t = items
    .map(({ x, y, size, text, anchor = 'start', weight = 600 }) =>
      `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="DejaVu Sans, Arial, sans-serif">${text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`)
    .join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${t}</svg>`);
}

export async function renderTestPattern(cfg, model) {
  const { width: W, height: H, rotate, name, orientation } = cfg.panel;
  const img = Buffer.alloc(W * H * 3, 255);
  const black = [0, 0, 0];
  const s = Math.min(W, H);
  const m = Math.round(s * 0.05);
  const inner = W - 2 * m;
  const texts = [];

  // Corner markers: all four should be fully visible.
  const arm = Math.round(s * 0.08), th = Math.max(6, Math.round(s * 0.006));
  for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]]) {
    const x0 = dx > 0 ? cx : cx - arm, y0 = dy > 0 ? cy : cy - th;
    fill(img, W, x0, y0, arm, th, black);
    const x1 = dx > 0 ? cx : cx - th, y1 = dy > 0 ? cy : cy - arm;
    fill(img, W, x1, y1, th, arm, black);
  }

  let y = m;
  const big = Math.round(s * 0.07);
  texts.push({ x: W / 2, y: y + big, size: big, text: '▲ TOP ▲', anchor: 'middle', weight: 800 });
  y += big + Math.round(s * 0.02);
  const small = Math.round(s * 0.022);
  texts.push({ x: W / 2, y: y + small, size: small, anchor: 'middle', weight: 400,
    text: `${name} ${W}×${H} ${orientation} · rotate ${rotate}° · dither ${cfg.image.dither}/${cfg.image.method}` });
  y += small + Math.round(s * 0.04);

  // Six inks as exact device colours.
  const inks = model.inks;
  const cols = W < H ? 3 : 6;
  const rowsN = Math.ceil(inks.length / cols);
  const gap = Math.round(s * 0.015);
  const sw = Math.floor((inner - gap * (cols - 1)) / cols);
  const sh = Math.round(sw * 0.55);
  inks.forEach((ink, i) => {
    const cx = m + (i % cols) * (sw + gap);
    const cy = Math.round(y + Math.floor(i / cols) * (sh + gap + small * 1.6));
    fill(img, W, cx, cy, sw, sh, ink.device);
    if (ink.name === 'white') { // outline the white swatch
      fill(img, W, cx, cy, sw, 2, black); fill(img, W, cx, cy + sh - 2, sw, 2, black);
      fill(img, W, cx, cy, 2, sh, black); fill(img, W, cx + sw - 2, cy, 2, sh, black);
    }
    texts.push({ x: cx + sw / 2, y: cy + sh + small * 1.2, size: small, text: ink.name, anchor: 'middle', weight: 400 });
  });
  y = Math.round(y + rowsN * (sh + gap + small * 1.6) + s * 0.02);

  // Same bands twice: dithered by us, and smooth (left to the display).
  const bh = Math.round((H - y - m - s * 0.22) / 2 - small * 2);
  if (bh < 30) throw new Error('Panel too small for the test pattern');
  const band = bands(inner, bh);
  texts.push({ x: m, y: y + small, size: small, text: 'Dithered by the NAS (should look clean, not re-mixed)' });
  y += Math.round(small * 1.5);
  const idx = dither(band, inner, bh, model, { method: cfg.image.method, kernel: cfg.image.kernel });
  const colors = inks.map((k) => (cfg.image.outputColors === 'measured' ? k.measured : k.device));
  const dith = indicesToRgb(idx, colors);
  for (let r = 0; r < bh; r++) dith.copy(img, ((y + r) * W + m) * 3, r * inner * 3, (r + 1) * inner * 3);
  y += bh + Math.round(small * 1.2);
  texts.push({ x: m, y: y + small, size: small, text: "Smooth (left to the display's own processing)" });
  y += Math.round(small * 1.5);
  for (let r = 0; r < bh; r++) band.copy(img, ((y + r) * W + m) * 3, r * inner * 3, (r + 1) * inner * 3);
  y += bh + Math.round(small * 1.2);

  // Fine patterns: grey-looking and even if the image is shown 1:1; moiré/blur means rescaling.
  texts.push({ x: m, y: y + small, size: small, text: '1-px checkerboard · 1-px lines · 2-px lines' });
  y += Math.round(small * 1.5);
  const ph = Math.min(Math.round(s * 0.12), H - y - m);
  const pw = Math.floor((inner - 2 * gap) / 3);
  for (let r = 0; r < ph; r++) {
    for (let c = 0; c < pw; c++) {
      const set = (x, on) => { const p = ((y + r) * W + x) * 3; const v = on ? 0 : 255; img[p] = img[p + 1] = img[p + 2] = v; };
      set(m + c, (r + c) % 2 === 0);
      set(m + pw + gap + c, c % 2 === 0);
      set(m + 2 * (pw + gap) + c, Math.floor(c / 2) % 2 === 0);
    }
  }

  // Text: rasterise, then snap to pure black so it stays crisp on the panel.
  const textLayer = await sharp(svgText(W, H, texts)).ensureAlpha().raw().toBuffer();
  for (let i = 0, p = 0; i < W * H; i++, p += 3) {
    if (textLayer[i * 4 + 3] > 110) { img[p] = 0; img[p + 1] = 0; img[p + 2] = 0; }
  }

  let out = sharp(img, { raw: { width: W, height: H, channels: 3 } });
  if (rotate) out = out.rotate(rotate);
  const devicePng = await out.png({ compressionLevel: 9 }).toBuffer();
  const previewPng = await sharp(img, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { devicePng, previewPng };
}

