// HTTP server: (1) what the display downloads, (2) a small status page with buttons.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { log, stamp } from './log.js';
import { UI_HTML } from './ui.js';
import { parseMultipart } from './multipart.js';

const MAX_PUSHES = 6;
const EPD_CONTENT_DIR = '/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents';
const MAX_POST_BYTES = 10 * 1024 * 1024; // what the display may POST to us (thumbnails, progress)

export function createServer(cfg, app) {
  const pushes = new Map();
  // The last requests from the display (and to the endpoints it uses), in /api/status.
  const traffic = [];
  const baseUrl = `http://${cfg.server.publicHost}:${cfg.server.port}`;
  const thumbnailUrl = `${baseUrl}/emdx/device-thumbnail`;

  // Register content for the display to download: one image, or a playlist of images that
  // the display plays by itself ({ items: [{ buf or file, ext, durationMs }], contentType:
  // 'PlaylistContent' }; `file`: served from disk). Returns URLs and a waiter.
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
      const size = it.buf ? it.buf.length : fs.statSync(it.file).size;
      return { i, fileId, fileName, ext, buf: it.buf, file: it.file, size, durationMs: it.durationMs ?? 91326, url: `${baseUrl}/emdx/${id}/${fileName}`, fetched: false };
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
            file_size: `${f.size}`,
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
      // What restoreContent() needs to serve it again (images in `items` order).
      saved: () => ({ id, json, files: files.map(({ fileName, ext }) => ({ fileName, ext })) }),
    };
  }

  // After a restart: serve content pushed before it again, under the same addresses, in case the
  // display asks for it again. `files`: [{ fileName, ext, file }], served from disk.
  function restoreContent({ id, json, files }) {
    const served = files.map((f, i) => ({ ...f, i })).filter((f) => fs.existsSync(f.file))
      .map((f) => ({ ...f, size: fs.statSync(f.file).size, fetched: true }));
    pushes.set(id, { id, files: served, json, waiters: new Set() });
    return served.length;
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

  // The display may POST a thumbnail of its screen (multipart: device_id, content_id,
  // content_name, content_type, content_player_type, schedule_downloaded_timestamp,
  // thumbnail_timestamp and an image file) after MDC 0xC7/0x54 with this URL. (The EM32DX
  // never has; Samsung's app gets them at /device-thumbnail.)
  async function receiveThumbnail(req, res, note) {
    let body = null;
    try {
      body = await readBody(req);
      note.bytes = body.length;
      const fields = {};
      let image = null;
      for (const part of parseMultipart(body, req.headers['content-type'])) {
        if (part.filename != null || /^image\//i.test(part.type || '')) {
          if (!image) image = { name: part.filename || part.name || '', type: part.type || '', buf: part.content };
        } else if (part.name) {
          fields[part.name] = part.content.toString('utf8').slice(0, 200);
        }
      }
      note.result = image ? `thumbnail ${(image.buf.length / 1024).toFixed(0)} kB` : 'no image in it';
      log.info(`Display sent a thumbnail (${image ? `${(image.buf.length / 1024).toFixed(0)} kB` : 'no image'}; ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')})`);
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');
      app.onThumbnail?.({ at: Date.now(), from: req.socket.remoteAddress, fields, image });
    } catch (err) {
      note.result = `unreadable: ${err.message}`;
      log.warn(`Could not read a thumbnail from the display (${req.headers['content-type'] || 'no content type'}, ${body?.length ?? '?'} bytes): ${err.message}`);
      res.writeHead(err.status || 200, { 'Content-Type': 'text/plain' }).end(err.status ? undefined : 'OK');
    }
  }

  // Samsung's app also takes download progress reports from the display; log any we get.
  async function receiveProgress(req, res, note) {
    try {
      const text = (await readBody(req)).toString('utf8').slice(0, 2000);
      note.result = text.slice(0, 160);
      log.info(`Display reported progress (${req.url}): ${text.replace(/\s+/g, ' ')}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(text.startsWith('{') ? text : '{}');
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

    // Note what the display asks for, and anything sent to the endpoints it uses.
    const fromDisplay = (req.socket.remoteAddress || '').replace(/^::ffff:/, '') === cfg.display.host;
    const displayPath = p.startsWith('/emdx/') || p.endsWith('/device-thumbnail') || p.endsWith('/content-transfer-progress');
    const note = { at: Date.now(), method: req.method, path: req.url.slice(0, 160), from: fromDisplay ? 'display' : (req.socket.remoteAddress || '').replace(/^::ffff:/, '') };
    if (fromDisplay || (displayPath && req.method === 'POST')) {
      if (req.headers['content-type']) note.type = req.headers['content-type'].slice(0, 100);
      if (req.headers['user-agent']) note.agent = req.headers['user-agent'].slice(0, 80);
      traffic.unshift(note);
      traffic.length = Math.min(traffic.length, 40);
      res.on('finish', () => { note.status = res.statusCode; });
    }

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
          'Content-Length': file.size,
        });
        if (req.method === 'HEAD') { res.end(); return; }
        res.on('finish', () => {
          const n = entry.files.length;
          log.info(`Display downloaded the image${n > 1 ? ` (${file.i + 1} of ${n})` : ''} (${(file.size / 1e6).toFixed(1)} MB)`);
          file.fetched = true;
          for (const w of [...entry.waiters]) w(true);
        });
        if (file.buf) res.end(file.buf);
        else fs.createReadStream(file.file).on('error', () => res.destroy()).pipe(res);
        return;
      }
      res.writeHead(404).end();
      return;
    }
    // Thumbnails: wherever the display POSTs them (the app's path is /device-thumbnail).
    if (p.endsWith('/device-thumbnail') && req.method === 'POST') return receiveThumbnail(req, res, note);
    if (p.endsWith('/content-transfer-progress') && req.method === 'POST') return receiveProgress(req, res, note);

    if (p === '/healthz') { res.writeHead(200).end('ok'); return; }

    // Anything else the display asks for: note it (it may tell us more about the protocol).
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
    const shot = /^\/img\/thumbnails\/([\w.-]+\.(?:png|jpe?g))$/.exec(p);
    if (shot && req.method === 'GET') {
      return sendFile(res, app.store.path('thumbnails', shot[1]), shot[1].endsWith('.png') ? 'image/png' : 'image/jpeg');
    }
    const slot = /^\/img\/playlist\/([\w-]+)\/(thumb\.jpg|preview\.jpg|preview\.png|source-[12]\.jpg)$/.exec(p);
    if (slot && req.method === 'GET') {
      return sendFile(res, app.store.path('playlist', slot[1], slot[2]), slot[2].endsWith('.png') ? 'image/png' : 'image/jpeg');
    }
    const actions = {
      '/api/next': () => app.next('manual'),
      '/api/resend': () => app.resend(),
      '/api/test-pattern': () => app.testPattern(),
      '/api/refresh-album': () => app.refreshLibrary(),
      '/api/sleep': () => app.sleepRightAway(),
    };
    const isAction = actions[p] || p === '/api/display-info';
    if (isAction && req.method === 'POST') {
      // Only accept button presses from this page (no cross-site requests).
      const origin = req.headers.origin;
      let sameHost = true;
      try { sameHost = !origin || new URL(origin).host === req.headers.host; } catch { sameHost = false; }
      if (!sameHost) return json(res, 403, { error: 'Cross-origin request refused' });
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
    restoreContent,
    recentTraffic: () => traffic.map((t) => ({ ...t })),
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
