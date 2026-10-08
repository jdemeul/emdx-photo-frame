// End to end: mock Google album -> pick/pair -> dither -> fake EMDX downloads it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { startMockGoogle } from './helpers/mockGoogle.js';
import { startFakeEmdx } from './helpers/fakeEmdx.js';
import { endpoints } from '../src/sources/googleAlbum.js';

let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }

let mock, emdx, dataDir;
before(async () => {
  if (!hasOpenssl) return;
  mock = await startMockGoogle({ landscape: 5, portrait: 3, video: 1 });
  emdx = await startFakeEmdx({ pin: '424242' });
  endpoints.batchexecute = mock.batchUrl;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-e2e-'));
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    ALBUM_URLS: mock.shortUrl,
    EMDX_HOST: '127.0.0.1',
    EMDX_PORT: String(emdx.port),
    EMDX_PIN: '424242',
    SERVER_HOST: '127.0.0.1',
    HTTP_PORT: '18321',
    ORIENTATION: 'portrait',
    FETCH_TIMEOUT_SEC: '20',
    CONNECT_ATTEMPTS: '2',
  });
});
after(async () => {
  await mock?.close();
  await emdx?.close();
});

test('a full day: album -> render -> display downloads a palette-only PNG', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  const { loadConfig, DEVICE_PALETTE } = await import('../src/config.js');
  const { Store } = await import('../src/state.js');
  const { buildPaletteModel } = await import('../src/color.js');
  const { FrameApp } = await import('../src/app.js');
  const { createServer } = await import('../src/server.js');

  const cfg = loadConfig();
  const model = buildPaletteModel(cfg.image.measuredPalette, DEVICE_PALETTE);
  const app = new FrameApp(cfg, new Store(cfg.dataDir), model);
  const server = createServer(cfg, app);
  app.server = server;
  await server.listen();
  try {
    const shownIds = [];
    for (let day = 0; day < 4; day++) {
      const cur = await app.next('schedule');
      assert.ok(cur.pushed);
      shownIds.push(...cur.ids);
    }
    // The display fetched 4 images (its last download may still be finishing).
    for (let i = 0; i < 50 && emdx.received.length < 4; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(emdx.received.length, 4);
    // Each is exactly the panel size and uses only the 6 device colours.
    const allowed = new Set(Object.values(DEVICE_PALETTE).map((h) => h.toLowerCase()));
    for (const { content, image } of emdx.received) {
      assert.equal(content.program_id, 'com.samsung.ios.ePaper');
      const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual([info.width, info.height], [1440, 2560]);
      const seen = new Set();
      for (let i = 0; i < data.length; i += info.channels) {
        seen.add('#' + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
      }
      for (const c of seen) assert.ok(allowed.has(c), `unexpected colour ${c}`);
    }
    // Battery was read; the video was never shown; no photo repeated within the cycle.
    assert.equal(app.state.battery.batteryPercent, 87);
    assert.ok(!shownIds.some((id) => id.startsWith('AF1QipV')));
    assert.equal(new Set(shownIds).size, shownIds.length);
    // Landscape photos on the portrait frame came in pairs.
    const kinds = app.state.history.filter((h) => h.ok).map((h) => h.kind);
    assert.ok(kinds.includes('pair'), `kinds: ${kinds}`);
    // The status API reflects it.
    const status = await (await fetch('http://127.0.0.1:18321/api/status')).json();
    assert.equal(status.current.pushed, true);
    assert.ok(status.library.count >= 8);
    const page = await (await fetch('http://127.0.0.1:18321/')).text();
    assert.match(page, /Photo frame/);
  } finally {
    await server.close();
  }
});
