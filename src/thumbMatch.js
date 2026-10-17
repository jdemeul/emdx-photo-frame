// Which of our photos is on the display? Compares a thumbnail the display sent (a small,
// possibly dithered and turned picture of its screen) with candidate images: both are shrunk to
// a few hundred pixels and compared by correlation, in all four orientations.
import sharp from 'sharp';

const W = 12;
const H = 20;

// A small colour fingerprint: W x H pixels (portrait), each channel centred on its mean, scaled
// to length 1.
async function fingerprint(input, rotate = 0) {
  const data = await sharp(input, { failOn: 'none' }).rotate(rotate).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer();
  const v = new Float64Array(W * H * 3);
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = c; i < data.length; i += 3) mean += data[i];
    mean /= W * H;
    for (let i = c; i < data.length; i += 3) v[i] = data[i] - mean;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// candidates: [{ key, file }] (files that may be missing are skipped). Returns { key, score,
// runnerUp, sure } for the best match (score: correlation, 1 = identical), or null.
export async function matchThumbnail(thumbnail, candidates) {
  const prints = [];
  for (const c of candidates) {
    try {
      prints.push({ key: c.key, v: await fingerprint(c.file) });
    } catch { /* missing or unreadable: skip */ }
  }
  if (!prints.length) return null;
  const turns = await Promise.all([0, 90, 180, 270].map((r) => fingerprint(thumbnail, r)));
  const scores = new Map();
  for (const p of prints) {
    const s = Math.max(...turns.map((t) => dot(t, p.v)));
    if (!(scores.get(p.key) >= s)) scores.set(p.key, s);
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const [key, score] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? null;
  return { key, score: +score.toFixed(3), runnerUp: runnerUp == null ? null : +runnerUp.toFixed(3), sure: score >= 0.6 && (runnerUp == null || score - runnerUp >= 0.15) };
}
