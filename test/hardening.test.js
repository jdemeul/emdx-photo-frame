// Failure modes found in an adversarial review (8 Nov 2026): each test shows the problem the
// fix addresses.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/state.js';
import { FrameApp } from '../src/app.js';
import { DailyPlaylist } from '../src/daily.js';
import { createServer } from '../src/server.js';
import { pushContent } from '../src/display.js';

let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }
const cleanups = [];
after(async () => { for (const f of cleanups.reverse()) await f(); });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `frame-${name}-`));

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// A FrameApp without the constructor's side effects, for the parts that don't talk to anything.
function bareApp(cfg, state = {}) {
  const app = Object.create(FrameApp.prototype);
  Object.assign(app, { cfg, busy: null, daily: null, store: { state, save() {}, path: (...p) => path.join('/nonexistent', ...p) } });
  return app;
}

test('timers and ports refuse values that would make the service knock on the display nonstop', () => {
  // (A negative interval: Node runs setInterval every millisecond.)
  assert.throws(() => withEnv({ SLEEP_CHECK_MIN: '-5' }, loadConfig), /SLEEP_CHECK_MIN must be a number at least 0/);
  assert.throws(() => withEnv({ MISSED_CHECK_SEC: '-1' }, loadConfig), /MISSED_CHECK_SEC/);
  assert.throws(() => withEnv({ RETRIES: '1.5' }, loadConfig), /RETRIES must be a whole number/);
  assert.throws(() => withEnv({ HTTP_PORT: '70000' }, loadConfig), /HTTP_PORT must be a whole number from 1 to 65535/);
  assert.throws(() => withEnv({ GAMMA: '0' }, loadConfig), /GAMMA/);
  assert.equal(withEnv({ SLEEP_CHECK_MIN: '0' }, loadConfig).sleep.checkMin, 0);
  // A quick look waits longer than Linux takes to say "host unreachable" for a stale ARP entry.
  assert.ok(withEnv({}, loadConfig).display.probeTimeoutSec >= 9);
});

test('a torn state file costs one save, not the whole state', () => {
  const dir = tmp('state');
  const a = new Store(dir);
  a.state.cycle = 7;
  a.save();
  a.state.cycle = 8;
  a.save();
  fs.writeFileSync(path.join(dir, 'state.json'), '{"cycle": 9, "bag": [');
  assert.equal(new Store(dir).state.cycle, 7); // the copy before the last save
  fs.writeFileSync(path.join(dir, 'state.json.bak'), 'null');
  assert.equal(new Store(dir).state.cycle, 0); // nothing usable: a fresh state, as before
});

test('a display found awake between light-sleep strikes starts the count over', () => {
  const cfg = withEnv({ SLEEP_MODE: 'deep' }, loadConfig);
  const app = bareApp(cfg, { history: [] });
  assert.equal(app.lightSleepSeen('on'), false); // strike 1
  app.noteWake();                                 // awake (a change, a button press)
  assert.equal(app.state.lightSleep, null);
  assert.equal(app.lightSleepSeen('on'), false); // strike 1 again, not 2
  assert.equal(app.lightSleepSeen('on'), false); // (after an update it stays on the Wi-Fi for a while)
  assert.equal(app.lightSleepSeen('on'), true);  // three in a row
  // One the NAS already tried to fix stays, with its tries, for the page.
  app.state.lightSleep.tries.push({ at: Date.now(), how: 'deep sleep command', result: 'not reached' });
  app.noteWake();
  assert.equal(app.state.lightSleep.tries.length, 1);
});

test('a cleaning time the display gave stays when a later read fails, and a failed read is tried again within the hour', () => {
  const cfg = withEnv({ EMDX_HOST: '192.0.2.1', CLEANING_TIME: '04:00' }, loadConfig);
  const app = bareApp(cfg, {});
  app.noteCleaning({ hour: 5, minute: 50 });
  app.noteCleaning({ error: 'unexpected answer [b0]' });
  assert.deepEqual([app.cleaning().hour, app.cleaning().minute, app.cleaning().source], [5, 50, 'display']);
  assert.equal(app.cleaningStatus().error, 'unexpected answer [b0]');
  assert.equal(app.cleaningDue(), false);
  app.state.cleaning.readAt -= 61 * 60000;
  assert.equal(app.cleaningDue(), true);
  // Never read: CLEANING_TIME stands in.
  const app2 = bareApp(cfg, {});
  app2.noteCleaning({ error: 'NAK' });
  assert.deepEqual([app2.cleaning().hour, app2.cleaning().source], [4, 'setting']);
});

test('at a change the NAS looks for the display first, and reads the album and renders afterwards', async () => {
  const calls = [];
  const daily = Object.create(DailyPlaylist.prototype);
  const app = bareApp({ display: { host: '192.0.2.1' }, sleep: { mode: 'deep' } }, { history: [] });
  app.state.playlist = { slots: [], batch: null, changes: [], seen: [] };
  Object.assign(daily, {
    app, cfg: app.cfg,
    advance: () => null,
    ensurePlan: async ({ fresh } = {}) => { calls.push(`plan${fresh ? ' (fresh)' : ''}`); },
    watchAfterChange: async () => { calls.push('watch'); },
    sendIfDue: async () => { calls.push('send'); },
  });
  await daily.scheduled('schedule');
  assert.deepEqual(calls, ['watch', 'plan (fresh)']);
  // With network standby (Wake-on-LAN reaches it) the plan comes first, then a due playlist.
  calls.length = 0;
  app.cfg.sleep.mode = 'standby';
  await daily.scheduled('schedule');
  assert.deepEqual(calls, ['plan (fresh)', 'send']);
});

// ---------- the web server ----------
async function startServer(env, app) {
  const cfg = withEnv({ SERVER_HOST: '127.0.0.1', ...env }, loadConfig);
  const server = createServer(cfg, app);
  await server.listen();
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${cfg.server.port}`;
}

test('a button pressed during a quick look at the display waits for it instead of failing as busy', async () => {
  const pressed = [];
  const app = { busy: { what: 'Looking for the display after the change', probe: true }, resend: async () => { pressed.push('resend'); } };
  const base = await startServer({ HTTP_PORT: '18501', EMDX_HOST: '' }, app);
  const r = await fetch(`${base}/api/resend`, { method: 'POST' });
  assert.equal(r.status, 202);
  assert.deepEqual(pressed, ['resend']);
  app.busy = { what: 'Sending the playlist' };
  assert.equal((await fetch(`${base}/api/resend`, { method: 'POST' })).status, 409);
});

test('only the display may send download progress reports', async () => {
  const base = await startServer({ HTTP_PORT: '18502', EMDX_HOST: '192.0.2.77' }, { busy: null });
  assert.equal((await fetch(`${base}/content-transfer-progress`, { method: 'POST', body: '{}' })).status, 403);
  const base2 = await startServer({ HTTP_PORT: '18503', EMDX_HOST: '127.0.0.1' }, { busy: null }); // (EMDX_HOST: this machine)
  const r = await fetch(`${base2}/content-transfer-progress`, { method: 'POST', body: '{"progress":50}' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { progress: 50 });
});

// ---------- the display ----------
test('a display that takes the content URL without answering in time, and downloads it all the same, counts as updated', { skip: !hasOpenssl && 'openssl not available', timeout: 60000 }, async () => {
  const { startFakeEmdx } = await import('./helpers/fakeEmdx.js');
  const emdx = await startFakeEmdx({ pin: '717171' });
  cleanups.push(() => emdx.close());
  emdx.state.ackContent = false;
  const cfg = withEnv({
    EMDX_HOST: '127.0.0.1', EMDX_PORT: String(emdx.port), EMDX_PIN: '717171', SERVER_HOST: '127.0.0.1', HTTP_PORT: '18504',
    FETCH_TIMEOUT_SEC: '5', CONNECT_ATTEMPTS: '1', EMDX_MAC: null,
  }, loadConfig);
  cfg.display.contentAckSec = 0.5;
  const server = createServer(cfg, { busy: null });
  await server.listen();
  cleanups.push(() => server.close());
  const png = Buffer.from('a png, as far as this test is concerned');
  const out = await pushContent(cfg, server, { items: [{ buf: png, ext: 'png' }] });
  assert.equal(emdx.received.length, 1);
  assert.ok(out.content);
  // One that never downloads it: the error says what happened.
  const silent = await import('./helpers/fakeEmdx.js').then((m) => m.startFakeEmdx({ pin: '717171', fetchImage: false }));
  cleanups.push(() => silent.close());
  silent.state.ackContent = false;
  cfg.display.port = silent.port;
  cfg.display.fetchTimeoutSec = 0.5;
  cfg.display.pushAttempts = 1;
  await assert.rejects(pushContent(cfg, server, { items: [{ buf: png, ext: 'png' }] }), /timed out .*downloaded nothing/);
});

test('a display found awake whose fresh playlist fails is left to go to sleep by itself, not powered off (playlist mode, deep sleep)', async () => {
  const cfg = withEnv({ EMDX_HOST: '192.0.2.1', SLEEP_MODE: 'deep', UPDATE_MODE: 'playlist' }, loadConfig);
  const app = bareApp(cfg, { history: [], batteryLog: [] });
  const calls = [];
  app.daily = { nearChange: () => false, onAwake: async () => { throw new Error('The display downloaded 10 of 22 images, then stopped'); } };
  app.look = async () => ({ awake: true, battery: { batteryPercent: 80, pluggedIn: false } });
  app.sleepNow = async () => { calls.push('power off'); };
  assert.equal(await app.checkAsleep(), true);
  assert.deepEqual(calls, []);
  assert.match(app.state.wakeEvents[0].error, /10 of 22/);
});

test('a network outage while downloading benches no photos; a photo that is gone is benched for a week', async () => {
  const cfg = withEnv({}, loadConfig);
  const app = bareApp(cfg, { bag: [], shownThisCycle: [], excluded: {}, history: [] });
  const items = ['a', 'b', 'c'].map((id) => ({ id, width: 3, height: 4, source: 'google' }));
  app.loadLibrary = async () => ({ items });
  app.skipVideos = async () => false;
  let photoProblem = false;
  app.download = async (plan) => { throw Object.assign(new Error(photoProblem ? 'HTTP 404' : 'fetch failed'), { itemId: plan.items[0].id, photoProblem }); };
  await assert.rejects(app.renderPhoto('/nonexistent', { say() {} }), /Could not download the photo: fetch failed/);
  assert.deepEqual(app.state.excluded, {});
  photoProblem = true;
  await assert.rejects(app.renderPhoto('/nonexistent', { say() {} }), /No usable photos|Could not download any photo/);
  assert.equal(Object.keys(app.state.excluded).length, 3);
});

// ---------- several frames ----------
test('several frames: each has its own settings, state folder and page; a single frame keeps working as before', async () => {
  const { loadFrames } = await import('../src/config.js');
  const { adoptLegacyData } = await import('../src/state.js');
  const dir = tmp('frames');
  const env = {
    DATA_DIR: dir, SERVER_HOST: '127.0.0.1', HTTP_PORT: '18471', UPDATE_MODE: 'playlist', SLEEP_MODE: 'deep', EMDX_PIN: '111111',
    FRAMES: 'hall, kitchen', HALL_EMDX_HOST: '10.9.9.1', KITCHEN_EMDX_HOST: '10.9.9.2', KITCHEN_EMDX_PIN: '222222',
    KITCHEN_NAME: 'Kitchen frame', KITCHEN_ORIENTATION: 'portrait', KITCHEN_SCHEDULE: '30 7 * * *',
  };
  const frames = loadFrames(env);
  assert.deepEqual(frames.map((f) => [f.id, f.name, f.cfg.display.host, f.cfg.display.pin, f.cfg.panel.orientation, f.cfg.schedule]), [
    ['hall', 'Hall', '10.9.9.1', '111111', 'landscape', '0 6 * * *'],
    ['kitchen', 'Kitchen frame', '10.9.9.2', '222222', 'portrait', '30 7 * * *'],
  ]);
  assert.deepEqual(frames.map((f) => f.cfg.dataDir), [path.join(dir, 'frames', 'hall'), path.join(dir, 'frames', 'kitchen')]);
  assert.equal(frames[0].cfg.server, frames[1].cfg.server); // one web server for all
  // Typos and clashes are caught when the config loads.
  assert.throws(() => loadFrames({ ...env, HALL_EMDX_HOTS: 'x' }), /HALL_EMDX_HOTS: there is no setting called EMDX_HOTS/);
  assert.throws(() => loadFrames({ ...env, HALL_HTTP_PORT: '1' }), /shared by all frames/);
  assert.throws(() => loadFrames({ ...env, FRAMES: 'emdx' }), /can't be a frame's name/);
  assert.throws(() => loadFrames({ ...env, KITCHEN_EMDX_HOST: '10.9.9.1' }), /same display address/);
  // Without FRAMES: one frame, with its state where it always was.
  const one = loadFrames({ DATA_DIR: dir, EMDX_HOST: '10.9.9.1' });
  assert.deepEqual(one.map((f) => [f.id, f.name, f.cfg.dataDir]), [['main', 'Photo frame', dir]]);

  // Going from one frame to several: the single frame's state becomes the first frame's, once.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ cycle: 7, history: [] }));
  fs.mkdirSync(path.join(dir, 'current'));
  fs.writeFileSync(path.join(dir, 'current', 'device.png'), 'x');
  assert.equal(adoptLegacyData(dir, frames[0].cfg.dataDir), true);
  assert.equal(adoptLegacyData(dir, frames[0].cfg.dataDir), false);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);

  const apps = frames.map((f) => new FrameApp(f.cfg, new Store(f.cfg.dataDir), null));
  assert.deepEqual(apps.map((a) => a.state.cycle), [7, 0]);
  assert.ok(fs.existsSync(apps[0].store.path('current', 'device.png')));
  const server = createServer(frames[0].cfg, apps);
  for (const a of apps) a.server = server;
  await server.listen();
  cleanups.push(() => server.close());
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:18471${p}`); return [r.status, await r.json()]; };
  const [, first] = await get('/api/status');
  const [, kitchen] = await get('/api/status?frame=kitchen');
  assert.deepEqual([first.frame, kitchen.frame], [{ id: 'hall', name: 'Hall' }, { id: 'kitchen', name: 'Kitchen frame' }]);
  assert.deepEqual(kitchen.frames.map((f) => [f.id, f.name, f.health.level]), [['hall', 'Hall', 'warn'], ['kitchen', 'Kitchen frame', 'warn']]); // (no playlist yet)
  assert.equal((await get('/api/status?frame=attic'))[0], 404);
  assert.equal((await get('/api/frames'))[1].length, 2);
  // A button press goes to the frame it was pressed for.
  apps[1].busy = { what: 'Sending the playlist' };
  const press = (q) => fetch(`http://127.0.0.1:18471/api/refresh-album${q}`, { method: 'POST' }).then((r) => r.status);
  assert.equal(await press('?frame=kitchen'), 409);
  apps[1].busy = null;
});

test('log lines say which frame they are about, also from timers started for it', async () => {
  const { log } = await import('../src/log.js');
  const lines = [];
  const real = console.log;
  console.log = (l) => lines.push(l);
  try {
    log.info('one frame');
    await log.scope('Hall', async () => {
      log.info('now');
      await new Promise((r) => setTimeout(() => { log.info('later'); r(); }, 5));
    });
  } finally { console.log = real; }
  assert.deepEqual(lines.map((l) => l.replace(/^\S+ \S+ INFO {2}/, '')), ['one frame', '[Hall] now', '[Hall] later']);
});
