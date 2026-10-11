// End to end: mock Google album -> pick/pair -> dither -> fake EMDX downloads it -> sleep -> Wake-on-LAN.
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
    DITHER: 'local', // this test checks the NAS ditherer's palette-only output
    FETCH_TIMEOUT_SEC: '20',
    CONNECT_ATTEMPTS: '2',
    EMDX_MAC: emdx.mac,
    WOL_BROADCAST: '127.0.0.1',
    WOL_PORT: String(emdx.wolPort),
    WAKE_WAIT_SEC: '0.2',
    SLEEP_MODE: '', // the default
    SLEEP_DELAY_SEC: '1',
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
      // No photo comes up twice in a cycle. (A pair may borrow a partner that was
      // already shown when no unseen one is left: there are 5 landscape photos.)
      assert.ok(!shownIds.includes(cur.ids[0]), `${cur.ids[0]} came up twice`);
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
    // Battery was read; the video was never shown.
    assert.equal(app.state.battery.batteryPercent, 87);
    assert.ok(!shownIds.some((id) => id.startsWith('AF1QipV')));
    // Landscape photos on the portrait frame came in pairs.
    const kinds = app.state.history.filter((h) => h.ok).map((h) => h.kind);
    assert.ok(kinds.includes('pair'), `kinds: ${kinds}`);
    // The status API reflects it.
    const status = await (await fetch('http://127.0.0.1:18321/api/status')).json();
    assert.equal(status.current.pushed, true);
    assert.ok(status.library.count >= 8);
    const page = await (await fetch('http://127.0.0.1:18321/')).text();
    assert.match(page, /Photo frame/);

    // Sleep (default: standby): SLEEP_DELAY_SEC after the last update the NAS checked
    // that network standby was on (it was) and powered the display off. Nothing tried
    // the timer command (0x25).
    const cmds = () => emdx.events.filter((e) => e.startsWith('cmd:'));
    await until(() => app.state.sleep?.asleep);
    assert.deepEqual(cmds().slice(-2), ['cmd:b5', 'cmd:11:0']);
    assert.ok(!cmds().some((e) => e.startsWith('cmd:25')));
    assert.deepEqual([emdx.state.awake, emdx.state.networkStandby], [false, true]);
    const asleep = await (await fetch('http://127.0.0.1:18321/api/status')).json();
    assert.deepEqual([asleep.sleep.mode, asleep.sleep.asleep], ['standby', true]);

    // The next update wakes it with Wake-on-LAN, and it goes back to sleep after.
    const woken = await app.next('manual');
    assert.ok(woken.pushed);
    assert.ok(emdx.events.includes('wol'));
    await until(() => app.state.sleep?.asleep && !emdx.state.awake);

    // If its Wi-Fi stops hearing Wake-on-LAN while it sleeps (network standby switched
    // off, as an EM32DX in deep sleep does after a while), an update says what to do,
    // and a manual one doesn't retry.
    emdx.state.networkStandby = false;
    cfg.display.connectAttempts = 1;
    await assert.rejects(app.resend(), /Wake-on-LAN did not wake it: check its battery and that its Network Standby is on/);
    assert.ok(emdx.events.includes('wol-unheard'));
    assert.equal(app.state.history[0].ok, false);
    assert.equal(app.retryTimer, null);

    // Someone presses its button: "Send again" works, and the update itself switches
    // network standby back on (the display may doze off before the NAS sends it to sleep).
    emdx.wake();
    const before = cmds().length;
    assert.ok((await app.resend()).pushed);
    assert.deepEqual(cmds().slice(before).filter((e) => !e.startsWith('cmd:1b')), ['cmd:b5', 'cmd:b5:1', 'cmd:c7']);
    assert.equal(emdx.state.networkStandby, true);
    await until(() => app.state.sleep?.asleep && !emdx.state.awake);
    assert.deepEqual(cmds().slice(-2), ['cmd:b5', 'cmd:11:0']);

    // If it has already gone to sleep by itself (out of reach) when the NAS wants to send
    // it to sleep, that counts as asleep rather than as a problem.
    emdx.wake();
    cfg.display.sleepWindowSec = 1;
    assert.ok((await app.resend()).pushed);
    emdx.state.awake = false;
    emdx.state.hearsWol = false;
    await until(() => app.state.sleep?.asleep);
    assert.equal(app.state.sleep.self, true);
    const selfSlept = await (await fetch('http://127.0.0.1:18321/api/status')).json();
    assert.deepEqual([selfSlept.sleep.asleep, selfSlept.sleep.self], [true, true]);
    emdx.state.hearsWol = true;

    // "Check display": Wake-on-LAN wakes it, the reading (with network standby) shows
    // on the page, and it is sent back to sleep afterwards.
    const info = await (await fetch('http://127.0.0.1:18321/api/display-info', { method: 'POST' })).json();
    assert.equal(info.networkStandby, 'on');
    assert.equal(info.battery.batteryPercent, 87);
    const checked = await (await fetch('http://127.0.0.1:18321/api/status')).json();
    assert.equal(checked.displayCheck.networkStandby, 'on');
    await until(() => app.state.sleep?.asleep && !emdx.state.awake);
  } finally {
    app.cancelSleep();
    await server.close();
  }
});

async function until(fn, ms = 15000) {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
