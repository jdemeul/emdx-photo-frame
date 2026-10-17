// HTTP server: (1) what the display downloads, (2) a small status page with buttons.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { log, stamp } from './log.js';
import { UI_HTML } from './ui.js';

const MAX_PUSHES = 6;
const EPD_CONTENT_DIR = '/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents';
const MAX_POST_BYTES = 10 * 1024 * 1024; // what the display may POST to us (thumbnails, progress)

export function createServer(cfg, app) {
  const pushes = new Map();
  const baseUrl = `http://${cfg.server.publicHost}:${cfg.server.port}`;
  const thumbnailUrl = `${baseUrl}/emdx/device-thumbnail`;

  // Register content for the display to download: one image, or a playlist of images that
  // the display plays by itself ({ items: [{ buf, ext, durationMs }], contentType:
  // 'PlaylistContent' }). Returns URLs and a waiter.
  //
  // The manifest is the Samsung E-Paper app's: one schedule entry (1970-01-01 to 2999-12-31,
  // from 00:00:00) with the images in order, each with its own duration in milliseconds (the
  // app's "24 h" playlist interval is 86400000). For one image we keep what node-samsung-emdx
  // sends (the iOS app's values, duration 91326), which is known to work on the EM32DX.
  // Slashes are escaped like the iOS app does.
  function registerContent({ items, contentType = 'ImageContent', name = 'emdx-photo-frame' }) {
    if (!items?.length) throw new Error('Nothing to send');
    const id = crypto.randomUUID().toUpperCase();
    const contentUrl = `${baseUrl}/emdx/${id}/content.json`;
    if (contentUrl.length > 255) throw new Error('Content URL is longer than the 255 characters MDC allows');
    const files = items.map((it, i) => {
      const fileId = items.length === 1 ? id : crypto.randomUUID().toUpperCase();
      const ext = it.ext || 'png';
      const fileName = `${fileId}.${ext}`;
      return { i, fileId, fileName, ext, buf: it.buf, durationMs: it.durationMs ?? 91326, url: `${baseUrl}/emdx/${id}/${fileName}`, fetched: false };
    });
    const json = JSON.stringify({
      schedule: [
        {
          start_date: '1970-01-01',
          stop_date: '2999-12-31',
          start_time: '00:00:00',
          contents: files.map((f) => ({
            image_url: f.url,
            file_id: f.fileId,
            file_path: `${EPD_CONTENT_DIR}/${f.fileId}/${f.fileName}`,
            duration: f.durationMs,
            file_size: `${f.buf.length}`,
            file_name: f.fileName,
          })),
        },
      ],
      name,
      version: 1,
      create_time: stamp(),
      id,
      program_id: 'com.samsung.ios.ePaper',
      content_type: contentType,
      deploy_type: 'MOBILE',
    }).replaceAll('/', '\\/');
    const entry = { id, files, json, waiters: new Set() };
    pushes.set(id, entry);
    while (pushes.size > MAX_PUSHES) pushes.delete(pushes.keys().next().value);
    const fetchedCount = () => files.filter((f) => f.fetched).length;
    return {
      id,
      count: files.length,
      imageUrl: files[0].url,
      contentUrl,
      // Resolves with the number of images fetched: once all are, or when no new one came
      // for `ms` (or done() was called).
      waitForImages(ms) {
        if (fetchedCount() === files.length) return Promise.resolve(files.length);
        return new Promise((resolve) => {
          let timer;
          const finish = () => { clearTimeout(timer); entry.waiters.delete(onFetch); resolve(fetchedCount()); };
          const arm = () => { clearTimeout(timer); timer = setTimeout(finish, ms); };
          const onFetch = (ok) => (!ok || fetchedCount() === files.length ? finish() : arm());
          entry.waiters.add(onFetch);
          arm();
        });
      },
      waitForImage(ms) {
        return this.waitForImages(ms).then((n) => n === files.length);
      },
      done() {
        for (const w of [...entry.waiters]) w(false);
      },
    };
  }

  function registerPush(buf, ext = 'png') {
    return registerContent({ items: [{ buf, ext }] });
  }

  // Read a request body, refusing more than MAX_POST_BYTES.
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_POST_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  // The display POSTs a thumbnail of its screen (multipart: device_id, content_id,
  // content_name, content_type, content_player_type, schedule_downloaded_timestamp,
  // thumbnail_timestamp and an image file) after MDC 0xC7/0x54 with this URL.
  async function receiveThumbnail(req, res) {
    try {
      const body = await readBody(req);
      const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] || '' } }).formData();
      const fields = {};
      let image = null;
      for (const [k, v] of form) {
        if (typeof v === 'string') fields[k] = v.slice(0, 200);
        else if (!image) image = { name: v.name, type: v.type, buf: Buffer.from(await v.arrayBuffer()) };
      }
      log.info(`Display sent a thumbnail (${image ? `${(image.buf.length / 1024).toFixed(0)} kB` : 'no image'}; ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')})`);
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
      app.onThumbnail?.({ at: Date.now(), from: req.socket.remoteAddress, fields, image });
    } catch (err) {
      log.warn(`Could not read a thumbnail from the display: ${err.message}`);
      res.writeHead(err.status || 400).end();
    }
  }

  // Samsung's app also takes download progress reports from the display; log any we get.
  async function receiveProgress(req, res) {
    try {
      const text = (await readBody(req)).toString('utf8').slice(0, 2000);
      log.info(`Display reported progress (${req.url}): ${text.replace(/\s+/g, ' ')}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(text.startsWith('{') ? text : '{}');
      app.onDisplayReport?.({ at: Date.now(), path: req.url, text });
    } catch (err) {
      res.writeHead(err.status || 400).end();
    }
  }

  function sendFile(res, file, type) {
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  }

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function authorized(req) {
    if (!cfg.server.uiPassword) return true;
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const decoded = Buffer.from(h.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1); // the password may contain colons
    const a = Buffer.from(pass);
    const b = Buffer.from(cfg.server.uiPassword);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // ---- endpoints the display uses (no auth: the display can't do it) ----
    const m = /^\/emdx\/([0-9A-F-]{36})\/([^/]+)$/.exec(p);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const entry = pushes.get(m[1]);
      if (!entry) { res.writeHead(404).end(); return; }
      if (m[2] === 'content.json') {
        log.info(`Display fetched content.json (${req.socket.remoteAddress})`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(entry.json) });
        res.end(req.method === 'HEAD' ? undefined : entry.json);
        return;
      }
      const file = entry.files.find((f) => f.fileName === m[2]);
      if (file) {
        res.writeHead(200, {
          'Content-Type': file.ext === 'png' ? 'image/png' : 'image/jpeg',
          'Content-Length': file.buf.length,
        });
        if (req.method === 'HEAD') { res.end(); return; }
        res.on('finish', () => {
          const n = entry.files.length;
          log.info(`Display downloaded the image${n > 1 ? ` (${file.i + 1} of ${n})` : ''} (${(file.buf.length / 1e6).toFixed(1)} MB)`);
          file.fetched = true;
          for (const w of [...entry.waiters]) w(true);
        });
        res.end(file.buf);
        return;
      }
      res.writeHead(404).end();
      return;
    }
    if (p === '/emdx/device-thumbnail' && req.method === 'POST') return receiveThumbnail(req, res);
    if (p.endsWith('/content-transfer-progress') && req.method === 'POST') return receiveProgress(req, res);

    if (p === '/healthz') { res.writeHead(200).end('ok'); return; }

    // Anything else the display asks for: note it (it may tell us more about the protocol).
    const fromDisplay = (req.socket.remoteAddress || '').replace(/^::ffff:/, '') === cfg.display.host;
    if (fromDisplay && !req.headers.authorization) log.info(`Display requested ${req.method} ${req.url}`);

    // ---- web UI ----
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="EMDX photo frame"' }).end('Authentication required');
      return;
    }
    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(UI_HTML);
      return;
    }
    if (p === '/api/status' && req.method === 'GET') return json(res, 200, app.status());
    const img = /^\/img\/(current|testpattern)\/(preview\.jpg|preview\.png|device\.png|source-[12]\.jpg)$/.exec(p);
    if (img && req.method === 'GET') {
      const type = img[2].endsWith('.png') ? 'image/png' : 'image/jpeg';
      return sendFile(res, app.store.path(img[1], img[2]), type);
    }
    const shot = /^\/img\/(thumbnails|playlist-test)\/([\w.-]+\.(?:png|jpe?g))$/.exec(p);
    if (shot && req.method === 'GET') {
      return sendFile(res, app.store.path(shot[1], shot[2]), shot[2].endsWith('.png') ? 'image/png' : 'image/jpeg');
    }
    const actions = {
      '/api/next': () => app.next('manual'),
      '/api/resend': () => app.resend(),
      '/api/test-pattern': () => app.testPattern(),
      '/api/refresh-album': () => app.refreshLibrary(),
      '/api/sleep': () => app.sleepRightAway(),
      '/api/playlist-test': () => app.playlistTest(),
    };
    const isAction = actions[p] || p === '/api/display-info' || p === '/api/stop-test';
    if (isAction && req.method === 'POST') {
      // Only accept button presses from this page (no cross-site requests).
      const origin = req.headers.origin;
      let sameHost = true;
      try { sameHost = !origin || new URL(origin).host === req.headers.host; } catch { sameHost = false; }
      if (!sameHost) return json(res, 403, { error: 'Cross-origin request refused' });
      if (p === '/api/stop-test') {
        const stopping = app.stopTest();
        return json(res, stopping ? 202 : 409, stopping ? { ok: true } : { error: 'No test is running' });
      }
      if (app.busy) return json(res, 409, { error: `Busy: ${app.busy.what}` });
      if (p === '/api/display-info') {
        // Wakes the display and reads it; answers when done.
        app.displayInfo().then((info) => json(res, 200, info), (err) => json(res, 502, { error: err.message }));
        return;
      }
      actions[p]().catch((err) => log.error(`${p} failed:`, err));
      return json(res, 202, { ok: true });
    }
    res.writeHead(404).end('not found');
  });

  return {
    baseUrl,
    thumbnailUrl,
    registerContent,
    registerPush,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.server.port, '0.0.0.0', () => {
          log.info(`HTTP server on port ${cfg.server.port}; the display will download from ${baseUrl}`);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
