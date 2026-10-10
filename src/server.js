// HTTP server: (1) what the display downloads, (2) a small status page with buttons.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { log, stamp } from './log.js';
import { UI_HTML } from './ui.js';

const MAX_PUSHES = 6;

export function createServer(cfg, app) {
  const pushes = new Map();
  const baseUrl = `http://${cfg.server.publicHost}:${cfg.server.port}`;

  // Register an image for the display to download; returns URLs and a waiter.
  function registerPush(buf, ext = 'png') {
    const id = crypto.randomUUID().toUpperCase();
    const fileName = `${id}.${ext}`;
    const imageUrl = `${baseUrl}/emdx/${id}/${fileName}`;
    const contentUrl = `${baseUrl}/emdx/${id}/content.json`;
    if (contentUrl.length > 255) throw new Error('Content URL is longer than the 255 characters MDC allows');
    // Same "mobile app" schedule format as node-samsung-emdx (slashes escaped like the iOS app does).
    const json = JSON.stringify({
      schedule: [
        {
          start_date: '1970-01-01',
          stop_date: '2999-12-31',
          start_time: '00:00:00',
          contents: [
            {
              image_url: imageUrl,
              file_id: id,
              file_path: `/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/${id}/${fileName}`,
              duration: 91326,
              file_size: `${buf.length}`,
              file_name: fileName,
            },
          ],
        },
      ],
      name: 'emdx-photo-frame',
      version: 1,
      create_time: stamp(),
      id,
      program_id: 'com.samsung.ios.ePaper',
      content_type: 'ImageContent',
      deploy_type: 'MOBILE',
    }).replaceAll('/', '\\/');
    const entry = { id, buf, fileName, json, ext, fetched: false, waiters: new Set() };
    pushes.set(id, entry);
    while (pushes.size > MAX_PUSHES) pushes.delete(pushes.keys().next().value);
    return {
      id,
      imageUrl,
      contentUrl,
      waitForImage(ms) {
        if (entry.fetched) return Promise.resolve(true);
        return new Promise((resolve) => {
          const done = (ok) => { clearTimeout(timer); entry.waiters.delete(done); resolve(ok); };
          const timer = setTimeout(() => done(false), ms);
          entry.waiters.add(done);
        });
      },
      done() {
        for (const w of [...entry.waiters]) w(false);
      },
    };
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
      if (m[2] === entry.fileName) {
        res.writeHead(200, {
          'Content-Type': entry.ext === 'png' ? 'image/png' : 'image/jpeg',
          'Content-Length': entry.buf.length,
        });
        if (req.method === 'HEAD') { res.end(); return; }
        res.on('finish', () => {
          log.info(`Display downloaded the image (${(entry.buf.length / 1e6).toFixed(1)} MB)`);
          entry.fetched = true;
          for (const w of [...entry.waiters]) w(true);
        });
        res.end(entry.buf);
        return;
      }
      res.writeHead(404).end();
      return;
    }

    if (p === '/healthz') { res.writeHead(200).end('ok'); return; }

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
    const actions = {
      '/api/next': () => app.next('manual'),
      '/api/resend': () => app.resend(),
      '/api/test-pattern': () => app.testPattern(),
      '/api/refresh-album': () => app.refreshLibrary(),
    };
    if (actions[p] && req.method === 'POST') {
      // Only accept button presses from this page (no cross-site requests).
      const origin = req.headers.origin;
      let sameHost = true;
      try { sameHost = !origin || new URL(origin).host === req.headers.host; } catch { sameHost = false; }
      if (!sameHost) return json(res, 403, { error: 'Cross-origin request refused' });
      if (app.busy) return json(res, 409, { error: `Busy: ${app.busy.what}` });
      actions[p]().catch((err) => log.error(`${p} failed:`, err));
      return json(res, 202, { ok: true });
    }
    res.writeHead(404).end('not found');
  });

  return {
    baseUrl,
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
