// Read a *shared* Google Photos album (a "photos.app.goo.gl/..." link with link
// sharing switched on) without the Google Photos API.
//
// Since March 2025 the official Library API can no longer read albums your own
// app didn't create, so this does what the album web page does: parse the item
// list embedded in the page, then page through the rest via the same internal
// endpoint the page itself uses. This is unofficial and may need updating if
// Google changes the page. Item list structure as used by the open-source
// projects google-photos-album-image-url-fetch and gphotos-scraper.
import { log } from '../log.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
  // Skip the EU cookie-consent interstitial.
  Cookie: 'SOCS=CAI',
};

export const endpoints = {
  // Overridable for tests.
  batchexecute: process.env.GOOGLE_PHOTOS_BATCH_URL || 'https://photos.google.com/_/PhotosUi/data/batchexecute',
};

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|3gp|3g2|mkv|webm|mts|m2ts|wmv|mpe?g)$/i;

async function http(url, opts = {}, timeoutMs = 30000) {
  const res = await fetch(url, {
    redirect: 'follow',
    ...opts,
    headers: { ...HEADERS, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

async function withRetries(fn, what, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        log.warn(`${what} failed (attempt ${i}/${attempts}): ${err.message}`);
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  }
  throw lastErr;
}

// Index of the bracket that closes the one at `start` (JSON-aware).
function matchBracket(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// All `AF_initDataCallback({key: 'ds:N', ..., data: [...]})` payloads in the page.
export function extractInitData(html) {
  const blocks = [];
  const marker = 'AF_initDataCallback(';
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const next = html.indexOf(marker, idx + marker.length);
    const limit = next === -1 ? html.length : next;
    const head = html.slice(idx, Math.min(limit, idx + 300));
    const key = /key:\s*'([^']+)'/.exec(head)?.[1];
    const dataPos = html.indexOf('data:', idx);
    if (dataPos !== -1 && dataPos < limit) {
      const start = html.indexOf('[', dataPos);
      const end = start === -1 ? -1 : matchBracket(html, start);
      if (end > start) {
        try {
          blocks.push({ key, data: JSON.parse(html.slice(start, end + 1)) });
        } catch {
          /* not JSON; ignore */
        }
      }
    }
    idx = next;
  }
  return blocks;
}

// One album item: [id, [url, width, height, ...], takenAtMs, ?, ?, addedAtMs, ...]
export function parseItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
    const d = e[1];
    if (!Array.isArray(d) || typeof d[0] !== 'string' || !/^https?:\/\//.test(d[0])) continue;
    const width = Number(d[1]);
    const height = Number(d[2]);
    if (!(width > 0 && height > 0)) continue;
    out.push({
      id: e[0],
      url: d[0],
      width,
      height,
      takenAt: typeof e[2] === 'number' ? e[2] : null,
      addedAt: typeof e[5] === 'number' ? e[5] : null,
    });
  }
  return out;
}

// Page payload: [?, items, nextPageToken, albumInfo(…, [1] = title), ...]
function parsePage(data) {
  const items = parseItems(data?.[1]);
  const token = typeof data?.[2] === 'string' && data[2] ? data[2] : null;
  const title = typeof data?.[3]?.[1] === 'string' ? data[3][1] : null;
  return { items, token, title };
}

export function parseShareUrl(finalUrl) {
  const u = new URL(finalUrl);
  const parts = u.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('share');
  const id = i >= 0 ? parts[i + 1] : null;
  const key = u.searchParams.get('key');
  return { id, key };
}

// batchexecute response: ")]}'" + JSON (or length-prefixed chunks of JSON).
export function parseBatchResponse(text, rpcId) {
  const body = text.replace(/^\)\]\}'\s*/, '');
  const candidates = [];
  try {
    candidates.push(JSON.parse(body));
  } catch {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (t.startsWith('[')) {
        try { candidates.push(JSON.parse(t)); } catch { /* skip */ }
      }
    }
  }
  const results = [];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    for (const entry of c) {
      if (Array.isArray(entry) && entry[1] === rpcId && typeof entry[2] === 'string') {
        try { results.push(JSON.parse(entry[2])); } catch { /* skip */ }
      }
    }
  }
  return results;
}

async function batchexecute(rpcId, payloads) {
  const freq = JSON.stringify([payloads.map((p) => [rpcId, JSON.stringify(p)])]);
  const res = await http(endpoints.batchexecute, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ 'f.req': freq }).toString(),
  });
  if (!res.ok) throw new Error(`batchexecute ${rpcId}: HTTP ${res.status}`);
  return parseBatchResponse(await res.text(), rpcId);
}

export async function fetchAlbum(shareUrl) {
  const res = await withRetries(() => http(shareUrl), `Opening album ${shareUrl}`);
  if (!res.ok) throw new Error(`Album link returned HTTP ${res.status} (is link sharing still on?)`);
  const html = await res.text();
  let { id, key } = parseShareUrl(res.url);
  if (!id || !key) {
    const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/.exec(html)?.[1];
    if (canonical) ({ id, key } = parseShareUrl(canonical.replace(/&amp;/g, '&')));
  }
  if (!id || !key) {
    if (/consent\.google\./.test(res.url)) {
      throw new Error('Google showed its cookie-consent page instead of the album. Please report this; the album reader needs updating.');
    }
    if (/\/album\//.test(res.url)) {
      throw new Error('That is a private album URL. In Google Photos use Share → "Create link" and paste the photos.app.goo.gl link.');
    }
    throw new Error(`Could not find the album id/key in ${res.url}`);
  }

  // First page is embedded in the HTML.
  let best = { items: [], token: null, title: null };
  for (const block of extractInitData(html)) {
    const page = parsePage(block.data);
    if (page.items.length > best.items.length) best = page;
  }
  let { items, token, title } = best;
  if (!items.length) {
    // Fall back to fetching the first page through the endpoint.
    const [data] = await withRetries(() => batchexecute('snAcKc', [[id, null, null, key]]), 'Album first page');
    ({ items, token, title } = parsePage(data));
  }

  const seen = new Set(items.map((it) => it.id));
  let pages = 1;
  while (token && pages < 500) {
    const [data] = await withRetries(() => batchexecute('snAcKc', [[id, token, null, key]]), `Album page ${pages + 1}`);
    const page = parsePage(data);
    for (const it of page.items) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    title = title || page.title;
    token = page.token;
    pages++;
  }
  if (!items.length) throw new Error('The album page contained no photos (empty album, or Google changed the page format).');
  return { id, key, title: title || 'Shared album', items, pages };
}

// Filename/description lookup for a few items; used to skip videos.
export async function fetchItemInfo(key, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const results = await batchexecute('fDcn4b', ids.map((id) => [id, null, key]));
  for (const r of results) {
    const d = r?.[0];
    if (!Array.isArray(d) || typeof d[0] !== 'string') continue;
    out.set(d[0], {
      description: typeof d[1] === 'string' ? d[1] : '',
      filename: typeof d[2] === 'string' ? d[2] : '',
      isVideo: typeof d[2] === 'string' && VIDEO_EXT.test(d[2]),
    });
  }
  return out;
}

// Ask Google for a version that is at least w x h (keeps aspect ratio).
export function sizedUrl(item, minW, minH) {
  const s = Math.max(minW / item.width, minH / item.height) * 1.15;
  const w = Math.min(item.width, Math.ceil(item.width * s));
  const h = Math.min(item.height, Math.ceil(item.height * s));
  return `${item.url}=w${w}-h${h}-no`;
}

export async function downloadImage(url) {
  return withRetries(async () => {
    const res = await http(url, {}, 60000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`Not an image (${type})`);
    return Buffer.from(await res.arrayBuffer());
  }, 'Downloading photo');
}
