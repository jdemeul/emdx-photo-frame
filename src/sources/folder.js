// Optional second source: photos in a folder on the NAS (mounted at PHOTO_DIR).
// Handy as a fallback, or to test the frame without Google.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { log } from '../log.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|tiff?|avif|gif)$/i;

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    log.warn(`Cannot read ${dir}: ${err.message}`);
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('@')) continue; // dotfiles, Synology @eaDir
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && IMAGE_EXT.test(e.name)) out.push(p);
  }
  return out;
}

// cache: { [relPath]: { size, mtimeMs, width, height } } — kept in state between runs.
export async function scanFolder(dir, cache = {}) {
  const files = await walk(dir);
  const items = [];
  const newCache = {};
  for (const file of files) {
    const rel = path.relative(dir, file);
    try {
      const st = await fs.stat(file);
      let meta = cache[rel];
      if (!meta || meta.size !== st.size || meta.mtimeMs !== st.mtimeMs) {
        const m = await sharp(file).metadata();
        let { width, height } = m;
        if (m.orientation && m.orientation >= 5) [width, height] = [height, width];
        meta = { size: st.size, mtimeMs: st.mtimeMs, width, height };
      }
      newCache[rel] = meta;
      if (!(meta.width > 0 && meta.height > 0)) continue;
      items.push({
        id: `file:${rel}`,
        path: file,
        width: meta.width,
        height: meta.height,
        takenAt: Math.round(meta.mtimeMs),
      });
    } catch (err) {
      log.warn(`Skipping ${rel}: ${err.message}`);
    }
  }
  return { items, cache: newCache };
}
