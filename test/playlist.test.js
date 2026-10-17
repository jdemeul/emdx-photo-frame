// The playlist test: telling the cards apart in thumbnails, reading the timing from the
// observations, and a full run against the fake display.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { renderTestCards, classifyThumbnail } from '../src/testCards.js';
import { analyzePlaylistTest, predict } from '../src/playlistTest.js';

const MIN = 60000;
const TZ = 'Europe/Brussels';
const small = { panel: { width: 360, height: 640, rotate: 0 }, timezone: TZ };

test('each test card is recognised in a thumbnail, also turned, shrunk or in dull inks', async () => {
  const cards = await renderTestCards(small, { minutes: [10, 20, 20, 20] });
  assert.equal(cards.length, 4);
  // The measured Spectra 6 inks, as a photo of the panel would show them.
  const dull = new Map([
    ['255,0,0', [0x62, 0x20, 0x1e]], ['255,255,0', [0xc1, 0xbb, 0x1e]],
    ['0,255,0', [0x35, 0x56, 0x3a]], ['0,0,255', [0x23, 0x3f, 0x8e]],
  ]);
  for (const c of cards) {
    assert.equal((await classifyThumbnail(c.png)).card, c.card);
    const turned = await sharp(c.png).rotate(90).resize(160).jpeg({ quality: 70 }).toBuffer();
    assert.equal((await classifyThumbnail(turned)).card, c.card, `card ${c.card} turned`);
    // Swap the pure inks for the dull measured ones.
    const { data, info } = await sharp(c.png).raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += info.channels) {
      const ink = dull.get(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      if (ink) [data[i], data[i + 1], data[i + 2]] = ink;
    }
    const muted = await sharp(data, { raw: info }).png().toBuffer();
    assert.equal((await classifyThumbnail(muted)).card, c.card, `card ${c.card} in dull inks`);
  }
  // A photo-like image (grey gradient) is no card.
  const grey = await sharp({ create: { width: 90, height: 160, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
  assert.equal((await classifyThumbnail(grey)).card, null);
});

// Observations every 2 minutes for 95 minutes, as a display following `model` would give.
function observe(model, t0, durations) {
  const obs = [];
  for (let t = t0 + 20000; t < t0 + 95 * MIN; t += 2 * MIN) obs.push({ at: t, card: predict(model, t, { t0, durations, tz: TZ }).card });
  return obs;
}

test('the analysis tells how the display timed the playlist', () => {
  const durations = [10, 20, 20, 20].map((m) => m * MIN);
  const t0 = Date.parse('2026-10-18T12:03:20Z'); // 14:03:20 in Brussels: not on a 70-minute boundary
  for (const model of ['push', 'midnight', 'epoch', 'push-equal']) {
    const r = analyzePlaylistTest({ t0, durations, observations: observe(model, t0, durations), tz: TZ });
    assert.equal(r.model, model, `${model}: ${r.verdict}`);
    assert.match(r.verdict, /moved on by itself/);
  }
  // Pushed to the display: card 1 first, switches 10, 30, 50 and 70 minutes later.
  const r = analyzePlaylistTest({ t0, durations, observations: observe('push', t0, durations), tz: TZ });
  assert.deepEqual(r.transitions.map((x) => `${x.from}>${x.to}`), ['1>2', '2>3', '3>4', '4>1', '1>2']);
  const firstSwitch = r.transitions[0];
  assert.ok(firstSwitch.after < t0 + 10 * MIN && firstSwitch.by > t0 + 10 * MIN);
  // Never moving on, too few thumbnails, none at all.
  const stuck = Array.from({ length: 40 }, (_, i) => ({ at: t0 + i * 2 * MIN, card: 1 }));
  assert.match(analyzePlaylistTest({ t0, durations, observations: stuck, tz: TZ }).verdict, /stayed on card 1 the whole time/);
  assert.match(analyzePlaylistTest({ t0, durations, observations: [{ at: t0, card: 1 }], tz: TZ }).verdict, /Too few/);
  assert.match(analyzePlaylistTest({ t0, durations, observations: [], tz: TZ }).verdict, /No thumbnails came back/);
  // Thumbnails right at a switch may show either card.
  const edge = observe('push', t0, durations).map((o) => ({ ...o }));
  edge.push({ at: t0 + 10 * MIN - 30000, card: 2 }); // 30 s early
  edge.sort((a, b) => a.at - b.at);
  assert.equal(analyzePlaylistTest({ t0, durations, observations: edge, tz: TZ }).model, 'push');
});

let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }

const cleanups = [];
after(async () => { for (const f of cleanups) await f(); });

// A run against the fake display, with "minutes" of one second.
let runs = 0;
async function runTest({ model = 'push', thumbnails = true } = {}) {
  const { startFakeEmdx } = await import('./helpers/fakeEmdx.js');
  const emdx = await startFakeEmdx({ pin: '515151', thumbnails });
  emdx.state.playlistModel = model;
  emdx.state.applySleep = true; // as the user may have set it in the app
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-playlist-'));
  Object.assign(process.env, {
    DATA_DIR: dataDir, ALBUM_URLS: '', EMDX_HOST: '127.0.0.1', EMDX_PORT: String(emdx.port), EMDX_PIN: '515151',
    SERVER_HOST: '127.0.0.1', HTTP_PORT: String(18400 + runs++), ORIENTATION: 'portrait',
    FETCH_TIMEOUT_SEC: '20', CONNECT_ATTEMPTS: '2', EMDX_MAC: emdx.mac, WOL_BROADCAST: '127.0.0.1',
    WOL_PORT: String(emdx.wolPort), WAKE_WAIT_SEC: '0.1', SLEEP_MODE: 'standby', SLEEP_DELAY_SEC: '1',
  });
  const { loadConfig, DEVICE_PALETTE } = await import('../src/config.js');
  const { Store } = await import('../src/state.js');
  const { buildPaletteModel } = await import('../src/color.js');
  const { FrameApp } = await import('../src/app.js');
  const { createServer } = await import('../src/server.js');
  const cfg = loadConfig();
  cfg.sleep.confirmSec = 2;
  cfg.sleep.confirmEverySec = 0.2;
  const app = new FrameApp(cfg, new Store(dataDir), buildPaletteModel(cfg.image.measuredPalette, DEVICE_PALETTE));
  const server = createServer(cfg, app);
  app.server = server;
  await server.listen();
  cleanups.push(async () => { app.cancelSleep(); await server.close(); await emdx.close(); });
  // A photo on the frame, to be put back after the test.
  fs.writeFileSync(`${dataDir}/current/device.png`, await sharp({ create: { width: 1440, height: 2560, channels: 3, background: '#808080' } }).png().toBuffer());
  app.state.current = { renderedAt: Date.now(), kind: 'cover', ids: [], items: [], pushed: true };
  const t = await app.playlistTest({ minutes: [2, 4, 4, 4], unitMs: 1000, pollSec: 0.5, extraMin: 2, thumbTimeoutSec: 3 });
  return { app, emdx, t, dataDir };
}

test('playlist test against the fake display: push-timed playlist, settings and photo put back', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  const { app, emdx, t, dataDir } = await runTest();
  // The display got a playlist the way Samsung's app sends one.
  const sent = emdx.received[0].content;
  assert.equal(sent.content_type, 'PlaylistContent');
  const items = sent.schedule[0].contents;
  assert.deepEqual(items.map((c) => c.duration), [2000, 4000, 4000, 4000]);
  assert.equal(new Set(items.map((c) => c.file_id)).size, 4);
  for (const c of items) assert.equal(c.file_path, `/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/${c.file_id}/${c.file_name}`);
  assert.equal(emdx.received[0].images.length, 4);
  // It saw the cards come and go, and worked out the timing.
  assert.equal(t.result.model, 'push', t.result.verdict);
  assert.deepEqual([...new Set(t.observations.filter((o) => o.card).map((o) => o.card))].sort(), [1, 2, 3, 4]);
  assert.equal(t.fields.content_type, 'PlaylistContent');
  assert.ok(fs.readdirSync(`${dataDir}/playlist-test`).some((f) => /^thumb-\d{6}-card[1-4]\.png$/.test(f)));
  // Settings back as they were, and the photo back on the frame (a single image again).
  assert.deepEqual([emdx.state.sleepAfter, emdx.state.applySleep], [[0x07], true]);
  const cmds = emdx.events.filter((e) => e.startsWith('cmd:c6') || e.startsWith('cmd:c7/53'));
  assert.deepEqual(cmds.slice(0, 4), ['cmd:c6:129', 'cmd:c7/53', 'cmd:c6:129,0', 'cmd:c7/53:1,0']);
  assert.deepEqual(cmds.slice(-2), ['cmd:c6:129,7', 'cmd:c7/53:1,1']);
  await until(() => emdx.received.length === 2); // its download of the photo may still be finishing
  assert.equal(emdx.received.at(-1).images.length, 1);
  assert.equal(t.done, true);
  // The page shows it, and the latest thumbnail can be opened.
  const status = await (await fetch(`http://127.0.0.1:${app.cfg.server.port}/api/status`)).json();
  assert.match(status.playlistTest.result.verdict, /moved on by itself, counted from when it received the playlist/);
  const shot = await fetch(`http://127.0.0.1:${app.cfg.server.port}/img/thumbnails/${status.thumbnail.file}`);
  assert.equal(shot.status, 200);
  // Back to sleep afterwards, as after any update.
  await until(() => app.state.sleep?.asleep && !emdx.state.awake);
});

test('playlist test: a display that never moves on, and one without thumbnails', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  const stuck = await runTest({ model: 'stuck' });
  assert.match(stuck.t.result.verdict, /stayed on card 1 the whole time/);
  const blind = await runTest({ thumbnails: false });
  assert.match(blind.t.result.verdict, /No thumbnails came back/);
  await until(() => blind.emdx.received.length === 2);
  assert.equal(blind.emdx.received.at(-1).images.length, 1); // the photo still went back
});

async function until(fn, ms = 10000) {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
