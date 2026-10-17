// Numbered test cards for the playlist test, and telling them apart in the display's
// thumbnails. Each card has a big block in one ink (red, yellow, green, blue), so the
// thumbnail's colour says which card is showing, whatever the display does to the image.
import sharp from 'sharp';

export const CARDS = [
  { name: 'red', rgb: [255, 0, 0], hue: 0 },
  { name: 'yellow', rgb: [255, 255, 0], hue: 60 },
  { name: 'green', rgb: [0, 255, 0], hue: 120 },
  { name: 'blue', rgb: [0, 0, 255], hue: 240 },
];

function svgText(W, H, items) {
  const t = items
    .map(({ x, y, size, text, weight = 600 }) =>
      `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif">${String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`)
    .join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${t}</svg>`);
}

const hhmm = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

// One PNG per card, at the panel's resolution (rotated like the photos). `minutes`: how
// long each card is meant to show.
export async function renderTestCards(cfg, { minutes, sentAt = new Date() }) {
  const { width: W, height: H, rotate } = cfg.panel;
  const s = Math.min(W, H);
  const out = [];
  for (let i = 0; i < minutes.length; i++) {
    const card = CARDS[i % CARDS.length];
    const img = Buffer.alloc(W * H * 3, 255);
    // The colour block: the middle of the frame, so a rotated thumbnail still shows it there.
    const bw = Math.round(W * 0.7), bh = Math.round(H * 0.4);
    const bx = Math.round((W - bw) / 2), by = Math.round((H - bh) / 2);
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        const p = (y * W + x) * 3;
        img[p] = card.rgb[0]; img[p + 1] = card.rgb[1]; img[p + 2] = card.rgb[2];
      }
    }
    const big = Math.round(s * 0.28), small = Math.round(s * 0.04);
    const label = minutes[i] % 60 === 0 && minutes[i] >= 60 ? `${minutes[i] / 60} h` : `${minutes[i]} min`;
    const texts = [
      { x: W / 2, y: by - Math.round(s * 0.06), size: big, text: String(i + 1), weight: 800 },
      { x: W / 2, y: Math.round(s * 0.09), size: small, text: 'Playlist test' },
      { x: W / 2, y: by + bh + Math.round(small * 1.8), size: small, text: `card ${i + 1} of ${minutes.length} · ${card.name} · ${label}`, weight: 400 },
      { x: W / 2, y: by + bh + Math.round(small * 3.4), size: small, text: `sent ${hhmm(sentAt, cfg.timezone)}`, weight: 400 },
    ];
    const textLayer = await sharp(svgText(W, H, texts)).ensureAlpha().raw().toBuffer();
    for (let k = 0, p = 0; k < W * H; k++, p += 3) {
      if (textLayer[k * 4 + 3] > 110) { img[p] = 0; img[p + 1] = 0; img[p + 2] = 0; }
    }
    let png = sharp(img, { raw: { width: W, height: H, channels: 3 } });
    if (rotate) png = png.rotate(rotate);
    out.push({ card: i + 1, color: card.name, png: await png.png({ compressionLevel: 9 }).toBuffer() });
  }
  return out;
}

function hueOf([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const c = max - min;
  if (!c) return { hue: null, sat: 0 };
  let h;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  return { hue: (h * 60 + 360) % 360, sat: c / max };
}

const hueDist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// Which card does this thumbnail show? Looks at the middle third of the image (the colour
// block, whichever way the thumbnail is turned) and lets each coloured pixel vote for the
// card with the nearest hue. Returns { card (1-based) or null, share, rgb }.
export async function classifyThumbnail(buf, cards = 4) {
  const { data, info } = await sharp(buf, { failOn: 'none' })
    .removeAlpha().resize(48, 48, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const votes = new Array(cards).fill(0);
  let coloured = 0, n = 0;
  const sum = [0, 0, 0];
  for (let y = 16; y < 32; y++) {
    for (let x = 16; x < 32; x++) {
      const p = (y * info.width + x) * info.channels;
      const rgb = [data[p], data[p + 1], data[p + 2]];
      n++; sum[0] += rgb[0]; sum[1] += rgb[1]; sum[2] += rgb[2];
      const { hue, sat } = hueOf(rgb);
      if (hue === null || sat < 0.25 || Math.max(...rgb) < 40) continue;
      coloured++;
      let best = 0;
      for (let k = 1; k < cards; k++) if (hueDist(hue, CARDS[k].hue) < hueDist(hue, CARDS[best].hue)) best = k;
      votes[best]++;
    }
  }
  const rgb = sum.map((v) => Math.round(v / n));
  const top = votes.indexOf(Math.max(...votes));
  const share = coloured ? votes[top] / n : 0;
  // A real card fills that area; ask for a clear majority of all the pixels looked at.
  return { card: share >= 0.4 ? top + 1 : null, share: Math.round(share * 100) / 100, rgb };
}
