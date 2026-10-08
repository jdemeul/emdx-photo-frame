// Layout (smart crop / pair / fit), tone adjustment, dithering and PNG encoding.
import sharp from 'sharp';
import { toneAdjust } from './tone.js';
import { dither, indicesToRgb } from './dither.js';

sharp.cache(false);
sharp.concurrency(2);

export function cropLoss(photoAspect, cellAspect) {
  return 1 - Math.min(photoAspect / cellAspect, cellAspect / photoAspect);
}

// Two cells that share the frame: stacked on a portrait frame, side by side on a
// landscape one. The split follows the photos' shapes so both lose about the same.
export function pairCells(width, height, gap, aspects = [1, 1]) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  if (width < height) {
    const avail = height - gap;
    const inv = aspects.map((a) => 1 / a);
    const h1 = clamp(Math.round((avail * inv[0]) / (inv[0] + inv[1])), Math.round(avail * 0.35), Math.round(avail * 0.65));
    return [
      { x: 0, y: 0, w: width, h: h1 },
      { x: 0, y: h1 + gap, w: width, h: avail - h1 },
    ];
  }
  const avail = width - gap;
  const w1 = clamp(Math.round((avail * aspects[0]) / (aspects[0] + aspects[1])), Math.round(avail * 0.35), Math.round(avail * 0.65));
  return [
    { x: 0, y: 0, w: w1, h: height },
    { x: w1 + gap, y: 0, w: avail - w1, h: height },
  ];
}

// Aspect ratio of one pair cell when split evenly (used to decide whether pairing helps).
export function pairCellAspect(width, height, gap) {
  const [c] = pairCells(width, height, gap, [1, 1]);
  return c.w / c.h;
}

// Plan -> list of cells: { rect, fit: 'cover' | 'contain' }
export function planCells(cfg, plan) {
  const { width, height } = cfg.panel;
  if (plan.kind === 'pair') {
    const rects = pairCells(width, height, cfg.layout.gap, plan.items.map((it) => (it.width && it.height ? it.width / it.height : 1)));
    return rects.map((rect) => ({ rect, fit: 'cover' }));
  }
  if (plan.kind === 'fit') {
    const m = cfg.layout.margin;
    return [{ rect: { x: m, y: m, w: width - 2 * m, h: height - 2 * m }, fit: 'contain' }];
  }
  return [{ rect: { x: 0, y: 0, w: width, h: height }, fit: 'cover' }];
}

async function prepareCell(input, cell, imageCfg) {
  const { w, h } = cell.rect;
  let img = sharp(input, { failOn: 'none' })
    .rotate() // honour EXIF orientation
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb');
  img = cell.fit === 'cover'
    ? img.resize(w, h, { fit: 'cover', position: sharp.strategy.attention, kernel: 'lanczos3' })
    : img.resize(w, h, { fit: 'inside', kernel: 'lanczos3' });
  if (imageCfg.sharpen > 0) img = img.sharpen({ sigma: imageCfg.sharpen });
  const { data, info } = await img.removeAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Unexpected channel count ${info.channels}`);
  const toned = toneAdjust(data, info.width, info.height, {
    saturation: imageCfg.saturation,
    contrast: imageCfg.contrast,
    autoLevels: imageCfg.autoLevels,
    gamma: imageCfg.gamma ?? 1,
  });
  return { data: toned, width: info.width, height: info.height };
}

// Compose the photos onto a paper-white canvas (sRGB, 3 channels).
export async function composeCanvas(cfg, plan, inputs) {
  const { width, height } = cfg.panel;
  const canvas = Buffer.alloc(width * height * 3, 255);
  const cells = planCells(cfg, plan);
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    const img = await prepareCell(inputs[c], cell, cfg.image);
    const ox = cell.rect.x + Math.floor((cell.rect.w - img.width) / 2);
    const oy = cell.rect.y + Math.floor((cell.rect.h - img.height) / 2);
    for (let y = 0; y < img.height; y++) {
      const cy = oy + y;
      if (cy < 0 || cy >= height) continue;
      const src = y * img.width * 3;
      const dst = (cy * width + ox) * 3;
      img.data.copy(canvas, dst, src, src + img.width * 3);
    }
  }
  return canvas;
}

async function encodePng(rgb, width, height, rotate = 0) {
  let img = sharp(rgb, { raw: { width, height, channels: 3 } });
  if (rotate) img = img.rotate(rotate);
  return img.png({ compressionLevel: 9, effort: 4 }).toBuffer();
}

// Full pipeline for a composed canvas -> files for the display and the web UI.
export async function renderCanvas(cfg, model, canvas) {
  const { width, height, rotate } = cfg.panel;
  const t0 = Date.now();
  if (cfg.image.dither === 'device') {
    // Let the display do its own colour processing: send the toned photo as-is.
    const devicePng = await encodePng(canvas, width, height, rotate);
    const previewPng = rotate ? await encodePng(canvas, width, height, 0) : devicePng;
    const previewJpg = await sharp(canvas, { raw: { width, height, channels: 3 } })
      .resize(Math.round(width / 2), Math.round(height / 2)).jpeg({ quality: 85 }).toBuffer();
    return { devicePng, previewPng, previewJpg, ms: Date.now() - t0, inkShare: null };
  }
  const indices = dither(canvas, width, height, model, {
    method: cfg.image.method,
    kernel: cfg.image.kernel,
  });
  const deviceColors = model.inks.map((k) => (cfg.image.outputColors === 'measured' ? k.measured : k.device));
  const previewColors = model.inks.map((k) => k.preview);
  const deviceRgb = indicesToRgb(indices, deviceColors);
  const previewRgb = indicesToRgb(indices, previewColors);
  const [devicePng, previewPng, previewJpg] = await Promise.all([
    encodePng(deviceRgb, width, height, rotate),
    encodePng(previewRgb, width, height, 0),
    // Half-size preview: averaging the dots approximates how it looks from across the room.
    sharp(previewRgb, { raw: { width, height, channels: 3 } })
      .resize(Math.round(width / 2), Math.round(height / 2), { kernel: 'cubic' })
      .jpeg({ quality: 88 }).toBuffer(),
  ]);
  const counts = new Array(model.inks.length).fill(0);
  for (let i = 0; i < indices.length; i++) counts[indices[i]]++;
  const inkShare = Object.fromEntries(model.inks.map((k, i) => [k.name, +(counts[i] / indices.length).toFixed(3)]));
  return { devicePng, previewPng, previewJpg, ms: Date.now() - t0, inkShare };
}
