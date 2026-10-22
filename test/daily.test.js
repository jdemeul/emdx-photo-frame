// UPDATE_MODE=playlist: the timing of a batch (across clock changes, repeating), matching
// thumbnails to photos, and a few days in fast motion against the fake display.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { changeClock, slotKey, dayLabel, buildBatch, positionAt } from '../src/playlist.js';
import { matchThumbnail } from '../src/thumbMatch.js';

const TZ = 'Europe/Brussels';
const H = 3600000;
const at = (iso) => Date.parse(iso);

// The plan for `now`: the slot showing now plus the next `days` changes.
function plan(clock, now, days) {
  return [clock.prev(now), ...clock.upcoming(days, now)].map((t) => ({ key: slotKey(t, TZ), at: t, dir: `d${t}` }));
}

test('a week from 17 Oct 17:00: the photo for now until 05:55, then one a day, 25 h across the clock change, and a repeat stays on time', () => {
  const clock = changeClock('55 5 * * *', TZ);
  const now = at('2026-10-17T15:00:00Z'); // 17:00 in Brussels
  const b = buildBatch({ now, slots: plan(clock, now, 7), clock });
  assert.deepEqual(b.items.map((it) => it.key), [
    '2026-10-17 05:55', '2026-10-18 05:55', '2026-10-19 05:55', '2026-10-20 05:55',
    '2026-10-21 05:55', '2026-10-22 05:55', '2026-10-23 05:55', '2026-10-24 05:55',
  ]);
  assert.deepEqual(b.items.map((it) => it.durationMs / H), [12 + 55 / 60, 24, 24, 24, 24, 24, 24, 25]); // summer time ends on 25 Oct
  assert.equal(slotKey(b.endsAt, TZ), '2026-10-25 05:55');
  // The tail shows the first photo again from 25 Oct 05:55 until 17:00, then item 1 (same photo)
  // runs its 12 h 55 min until 26 Oct 05:55: on time again.
  assert.equal(b.tail.key, '2026-10-17 05:55');
  assert.equal(b.tail.durationMs, 11 * H + 5 * 60000);
  const where = (iso) => { const p = positionAt(b, at(iso)); return [p.index, p.item.key, p.loop, slotKey(p.since, TZ)]; };
  assert.deepEqual(where('2026-10-18T03:54:00Z'), [0, '2026-10-17 05:55', 0, '2026-10-17 17:00']);
  assert.deepEqual(where('2026-10-18T03:56:00Z'), [1, '2026-10-18 05:55', 0, '2026-10-18 05:55']);
  assert.deepEqual(where('2026-10-25T05:00:00Z'), [-1, '2026-10-17 05:55', 0, '2026-10-25 05:55']);
  assert.deepEqual(where('2026-10-26T04:54:00Z'), [0, '2026-10-17 05:55', 1, '2026-10-25 17:00']);
  assert.deepEqual(where('2026-10-26T04:56:00Z'), [1, '2026-10-18 05:55', 1, '2026-10-26 05:55']);
  assert.equal(dayLabel(now, TZ), 'Sat 17 Oct');
});

test('minutes before a change, the list starts with the next photo; a gap in the plan ends the list', () => {
  const clock = changeClock('55 5 * * *', TZ);
  const now = at('2026-10-18T03:50:00Z'); // 05:50
  const slots = plan(clock, now, 3);
  const b = buildBatch({ now, slots, clock });
  assert.equal(b.items[0].key, '2026-10-18 05:55');
  assert.equal(b.items[0].durationMs, 24 * H + 5 * 60000);
  assert.equal(b.items.length, 3);
  // Without the photo for 19 Oct, only the run up to the gap goes out.
  const gappy = buildBatch({ now: at('2026-10-17T15:00:00Z'), slots: slots.filter((s) => s.key !== '2026-10-19 05:55'), clock });
  assert.deepEqual(gappy.items.map((it) => it.key), ['2026-10-17 05:55', '2026-10-18 05:55']);
  // Nothing planned for now: nothing to send.
  assert.equal(buildBatch({ now: at('2026-10-30T12:00:00Z'), slots, clock }), null);
});

test('the battery log gives one reading per day, the first of the day, newest day first', async () => {
  const { batteryDays } = await import('../src/app.js');
  const log = [
    { at: at('2026-10-17T07:31:00Z'), percent: 55, charging: false },
    { at: at('2026-10-17T14:34:00Z'), percent: 100, charging: true },
    { at: at('2026-10-18T04:00:20Z'), percent: 100, charging: false },
    { at: at('2026-10-19T04:00:10Z'), percent: 99, charging: false },
    { at: at('2026-10-19T16:15:00Z'), percent: 98, charging: false },
  ];
  assert.deepEqual(batteryDays(log, TZ).map((d) => `${d.day} ${d.percent}`), ['Mon 19 Oct 99', 'Sun 18 Oct 100', 'Sat 17 Oct 55']);
  assert.deepEqual(batteryDays([], TZ), []);
});

test('state from the version with the playlist test: settings it left changed are flagged, old wake-ups labelled, thumbnails and battery carried over', async () => {
  const { upgradeState } = await import('../src/app.js');
  const t0 = at('2026-10-18T04:00:00Z');
  const st = {
    playlist: { pending: null, seen: [{ note: 'no thumbnail came back' }] },
    playlistTest: { done: false, saved: { sleepAfter: 0x0a, applySleep: 1 }, observations: [{ error: 'timeout' }, { ok: true }, { error: 'timeout' }] },
    thumbnailFailures: 2,
    history: [
      { at: t0 + 15 * 60000, ok: true, kind: 'pair', battery: 96 },
      { at: t0 + 20000, ok: true, kind: 'playlist sent: 30 photos, until Mon 16 Nov', battery: 97 },
    ],
    wakeEvents: [
      { at: t0 + 14 * 60000, sent: true, battery: 96 }, // a photo, sent a minute later
      { at: t0 + 10000, afterChange: true, battery: 97 },
      { at: t0, sent: true }, // the playlist, sent 20 s later
    ],
  };
  upgradeState(st);
  assert.match(st.lastError.message, /playlist test was cut short and left the display's Sleep After/);
  assert.equal(st.playlist.pending, 'the playlist test replaced the playlist');
  assert.deepEqual(st.wakeEvents.map((e) => e.sent), ['photo', undefined, 'playlist']);
  assert.deepEqual(st.thumbs, { asked: 3, received: 0 });
  assert.deepEqual(st.batteryLog.map((r) => r.percent), [96]); // within half an hour: the latest
  assert.deepEqual([st.playlistTest, st.pendingRestore, st.thumbnailFailures], [undefined, undefined, undefined]);
  // Already upgraded state is left alone.
  const again = structuredClone(st);
  upgradeState(again);
  assert.deepEqual(again, st);
});

test('spring forward: 02:30 does not exist on 28 Mar 2027, so that change comes at 03:30', () => {
  const clock = changeClock('30 2 * * *', TZ);
  const now = at('2027-03-27T12:00:00Z');
  const b = buildBatch({ now, slots: plan(clock, now, 2), clock });
  assert.deepEqual(b.items.map((it) => it.key), ['2027-03-27 02:30', '2027-03-28 03:30', '2027-03-29 02:30']);
  assert.deepEqual(b.items.slice(1).map((it) => it.durationMs / H), [23, 24]);
  // Between 03:00 and 03:30 that night the last change is still the one of the 27th.
  for (const t of ['2027-03-28T01:00:00Z', '2027-03-28T01:15:00Z', '2027-03-28T01:29:59Z']) {
    assert.equal(slotKey(clock.prev(at(t)), TZ), '2027-03-27 02:30', t);
  }
  assert.equal(slotKey(clock.prev(at('2027-03-28T01:30:00Z')), TZ), '2027-03-28 03:30');
  // Changes every few seconds (as in the tests below) get unique names.
  const fast = changeClock('*/12 * * * * *', TZ);
  const [x, y] = fast.upcoming(2, at('2026-10-17T15:00:01Z'));
  assert.deepEqual([slotKey(x, TZ), slotKey(y, TZ)], ['2026-10-17 17:00:12', '2026-10-17 17:00:24']);
});

test('the sleep check leaves the display alone from 15 minutes before a change until 15 minutes after', async () => {
  const { DailyPlaylist } = await import('../src/daily.js');
  const app = {
    cfg: { schedule: '0 6 * * *', timezone: TZ, update: { days: 30, topUpDays: 7, quietSec: 15 * 60 } },
    state: {},
    store: { save() {}, path: (...p) => path.join(os.tmpdir(), 'no-such-dir', ...p) },
  };
  const daily = new DailyPlaylist(app);
  const quiet = (hm) => daily.nearChange(at(`2026-10-21T${hm}:00+02:00`));
  assert.deepEqual(['05:02', '05:44', '05:46', '05:57', '06:00', '06:14', '06:16', '12:00'].map(quiet),
    [false, false, true, true, true, true, false, false]);
  daily.watch = { at: at('2026-10-21T06:00:00+02:00') }; // still looking for it after the change
  assert.equal(quiet('06:16'), true);
  // Changes every 20 minutes: 5 minutes on either side, so the sleep check still runs in between.
  app.cfg.schedule = '*/20 * * * *';
  const often = new DailyPlaylist(app);
  const quietOften = (hm) => often.nearChange(at(`2026-10-21T${hm}:00+02:00`));
  assert.deepEqual(['06:04', '06:06', '06:14', '06:16'].map(quietOften), [true, false, false, true]);
});

test('a long playlist gets a fresh one only once it runs short (PLAYLIST_TOPUP_DAYS)', async () => {
  const { DailyPlaylist } = await import('../src/daily.js');
  const app = {
    cfg: { schedule: '55 5 * * *', timezone: TZ, update: { days: 30, topUpDays: 7 } },
    state: {},
    store: { save() {}, path: (...p) => path.join(os.tmpdir(), 'no-such-dir', ...p) },
  };
  const daily = new DailyPlaylist(app);
  const now = at('2026-10-17T15:00:00Z');
  const b = buildBatch({ now, slots: plan(daily.clock, now, 30), clock: daily.clock });
  app.state.playlist.batch = { ...b, schedule: '55 5 * * *', days: 30 };
  assert.equal(daily.daysLeft(now + 60000), 30);
  assert.equal(daily.due(now + 60000), null);
  assert.equal(daily.due(at('2026-10-18T05:00:00Z')), null); // 29 to come
  assert.equal(daily.due(at('2026-11-09T06:00:00Z')), null); // 7 to come
  assert.equal(daily.due(at('2026-11-10T06:00:00Z')), 'only 6 days of photos left on the display');
  assert.equal(daily.due(b.endsAt + H), 'the playlist on the display has run out');
  app.state.playlist.pending = 'a new photo for now';
  assert.equal(daily.due(now + 60000), 'a new photo for now');
});

// Distinct test photos: a few shapes in different places and colours.
function photoSvg(i, w = 300, h = 500) {
  const hue = (i * 67) % 360;
  const x = 20 + ((i * 53) % (w - 140));
  const y = 30 + ((i * 97) % (h - 200));
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="hsl(${hue},45%,${35 + (i % 3) * 15}%)"/>
    <circle cx="${x + 60}" cy="${y + 60}" r="${50 + (i % 4) * 10}" fill="hsl(${(hue + 150) % 360},80%,60%)"/>
    <rect x="${w - x - 100}" y="${h - y - 120}" width="90" height="140" fill="hsl(${(hue + 240) % 360},70%,${20 + (i % 5) * 12}%)"/>
    <rect x="0" y="${(i * 37) % h}" width="${w}" height="24" fill="#fff"/>
  </svg>`);
}

test('a thumbnail of the screen is matched to the right photo, also turned, small and dithered to six inks', async () => {
  const files = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbmatch-'));
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, `p${i}.jpg`);
    fs.writeFileSync(f, await sharp(photoSvg(i)).jpeg({ quality: 85 }).toBuffer());
    files.push({ key: `k${i}`, file: f });
  }
  const shown = await sharp(files[3].file).toBuffer();
  const thumbs = [
    await sharp(shown).resize(90, 150).jpeg({ quality: 60 }).toBuffer(),
    await sharp(shown).rotate(90).resize(160).png().toBuffer(), // in the panel's landscape orientation
    await sharp(shown).resize(120, 200).png({ palette: true, colors: 6, dither: 1 }).toBuffer(), // dithered
  ];
  for (const t of thumbs) {
    const m = await matchThumbnail(t, files);
    assert.equal(m.key, 'k3');
    assert.ok(m.sure, JSON.stringify(m));
  }
  assert.equal(await matchThumbnail(thumbs[0], [{ key: 'x', file: path.join(dir, 'missing.jpg') }]), null);
});

// ---------- a few "days" of 12 seconds against the fake display ----------
let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }
const cleanups = [];
after(async () => { for (const f of cleanups) await f(); });

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await sleepMs(50);
  }
}

test('playlist mode: plan, send when found awake, the display moves on by itself, top-ups, a new photo for now', { skip: !hasOpenssl && 'openssl not available', timeout: 180000 }, async () => {
  const { startFakeEmdx } = await import('./helpers/fakeEmdx.js');
  const emdx = await startFakeEmdx({ pin: '616161' });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-daily-'));
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-daily-photos-'));
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(photoDir, `p${String(i).padStart(2, '0')}.jpg`), await sharp(photoSvg(i)).jpeg({ quality: 85 }).toBuffer());
  Object.assign(process.env, {
    DATA_DIR: dataDir, ALBUM_URLS: '', PHOTO_DIR: photoDir, EMDX_HOST: '127.0.0.1', EMDX_PORT: String(emdx.port), EMDX_PIN: '616161',
    SERVER_HOST: '127.0.0.1', HTTP_PORT: '18461', PANEL_WIDTH: '640', PANEL_HEIGHT: '360', ORIENTATION: 'portrait',
    FETCH_TIMEOUT_SEC: '20', CONNECT_ATTEMPTS: '2', EMDX_MAC: emdx.mac, WOL_BROADCAST: '127.0.0.1', WOL_PORT: String(emdx.wolPort),
    WAKE_WAIT_SEC: '0.1', SLEEP_MODE: 'deep', SLEEP_DELAY_SEC: '1', WAKE_WINDOW_MIN: '0.05', SLEEP_CHECK_MIN: '0',
    UPDATE_MODE: 'playlist', PLAYLIST_DAYS: '3', SCHEDULE: '*/12 * * * * *', TZ,
  });
  try {
    const { loadConfig, DEVICE_PALETTE } = await import('../src/config.js');
    const { Store } = await import('../src/state.js');
    const { buildPaletteModel } = await import('../src/color.js');
    const { FrameApp } = await import('../src/app.js');
    const { createServer } = await import('../src/server.js');
    const cfg = loadConfig();
    Object.assign(cfg.update, { minFirstSec: 1, minTailSec: 0.2, watchEverySec: 0.5, thumbTimeoutSec: 3, quietSec: 0.5 });
    Object.assign(cfg.sleep, { confirmSec: 2, confirmEverySec: 0.2, ownSleepSec: 0 });
    emdx.state.sleepsAfterUpdateMs = 1500; // (like the EM32DX: asleep a little after an update)
    Object.assign(cfg.display, { sleepWindowSec: 1, awakeWindowSec: 1 });
    const app = new FrameApp(cfg, new Store(dataDir), buildPaletteModel(cfg.image.measuredPalette, DEVICE_PALETTE));
    const server = createServer(cfg, app);
    app.server = server;
    await server.listen();
    cleanups.push(async () => { app.cancelSleep(); await server.close(); await emdx.close(); });
    const clock = app.daily.clock;
    const pl = () => app.state.playlist;
    const device = (dir) => fs.readFileSync(path.join(dataDir, 'playlist', dir, 'device.png'));
    const slotStart = async () => sleepMs(clock.next(Date.now()) - Date.now() + 200);
    const powerOffs = () => emdx.events.filter((e) => e === 'cmd:11:0').length;

    // A photo is on the frame from before (push mode). Switching to playlist mode keeps it for now.
    await slotStart();
    await app.prepare('manual');
    app.state.current.pushed = true;
    const before = fs.readFileSync(path.join(dataDir, 'current', 'device.png'));
    await app.daily.startup();
    assert.equal(pl().slots.length, 4); // now + 3 changes
    assert.deepEqual(pl().slots[0].ids, app.state.current.ids);
    assert.deepEqual(pl().slots.slice(1).map((s) => s.at), clock.upcoming(3, pl().slots[0].at));
    assert.equal(new Set(pl().slots.flatMap((s) => s.ids)).size, pl().slots.flatMap((s) => s.ids).length, 'a photo planned twice');
    assert.equal(app.daily.due(), 'the display has no playlist yet');
    // (At least a second into the slot, so that the first item and the tail are both there.)
    const into = Date.now() - clock.prev(Date.now());
    if (into < 1000) await sleepMs(1000 - into);

    // The sleep check finds the display awake: it gets the playlist, with deep sleep set up.
    assert.equal(await app.checkAsleep(), true);
    assert.equal(app.state.wakeEvents[0].sent, 'playlist');
    await until(() => emdx.received.length === 1); // the fake notes it once its last download is done
    const first = emdx.received[0];
    assert.equal(first.content.content_type, 'PlaylistContent');
    const durations = first.content.schedule[0].contents.map((c) => c.duration);
    assert.equal(durations.length, 5, `durations ${durations}`); // now, 3 changes, and the tail
    assert.ok(durations[0] > 1000 && durations[0] <= 12000, `first ${durations[0]}`);
    assert.deepEqual(durations.slice(1, 4), [12000, 12000, 12000]);
    assert.ok(Math.abs(durations[0] + durations[4] - 12000) < 5, `first + tail = ${durations[0] + durations[4]}`);
    assert.ok(first.images[0].equals(before), 'the photo for now is the one that was on the frame');
    assert.ok(first.images[4].equals(before), 'the tail repeats it');
    assert.deepEqual([emdx.state.applySleep, emdx.state.networkStandby], [false, false]); // its own sleep setting is left alone
    assert.equal(app.daily.due(), null);
    // It goes to sleep by itself (no power-off command), and the sleep check notes that.
    assert.equal(app.sleepStatus().own, true);
    await until(() => !emdx.state.awake);
    assert.equal(await app.checkAsleep(), false);
    assert.deepEqual([app.state.sleep.asleep, app.state.sleep.self, powerOffs()], [true, true, 0]);

    // Found awake again before the next change, with nothing due: it goes back to sleep by itself,
    // so the NAS leaves it alone; still awake at the next check, it is sent to sleep.
    emdx.wake();
    assert.equal(await app.checkAsleep(), true);
    assert.equal(app.state.wakeEvents[0].leftAlone, true);
    assert.equal(emdx.state.awake, true);
    assert.equal(pl().seen[0].seen, pl().seen[0].expected);
    assert.equal(await app.checkAsleep(), true);
    assert.equal(app.state.wakeEvents[0].putBack, true);
    assert.equal(emdx.state.awake, false);

    // At the change the display moves on by itself (in deep sleep); the NAS notes it, looks for
    // the display for a while (it stays offline) and prepares the photo for the new last day.
    // (The display starts counting once it has the playlist, a little after the NAS worked out
    // the durations, so it changes a moment after the change time.)
    await sleepMs(clock.next(Date.now()) - Date.now() + 200);
    await until(() => emdx.showing().index === 1, 5000);
    await app.scheduled('schedule');
    const [b1] = [pl().batch];
    assert.equal(app.state.current.slotDir, b1.items[1].dir);
    assert.equal(app.state.current.byDisplay, true);
    assert.match(app.state.history.find((h) => h.ok).kind, /changed by the display \(expected\)/);
    assert.equal(pl().changes[0].online, null);
    assert.equal(pl().slots.length, 4);
    assert.ok(fs.existsSync(path.join(dataDir, 'playlist', b1.items[0].dir)), 'files of the playlist on the display are kept');
    assert.equal(app.daily.due(), 'only 2 days of photos left on the display'); // fewer than PLAYLIST_TOPUP_DAYS (here 3)

    // Someone presses its button: the NAS asks what it shows (the right photo), then tops it up,
    // starting with the photo it shows now.
    emdx.wake();
    assert.equal(await app.checkAsleep(), true);
    const seen = pl().seen[0];
    assert.equal(seen.how, 'found awake');
    assert.equal(seen.seen, seen.expected);
    assert.ok(seen.sure, JSON.stringify(seen));
    assert.equal(app.state.wakeEvents[0].sent, 'playlist');
    const b2 = pl().batch;
    assert.ok(b2.sentAt > b1.sentAt);
    assert.equal(b2.items[0].dir, b1.items[1].dir);
    await until(() => emdx.received.length === 2);
    assert.ok(emdx.received.at(-1).images[0].equals(device(b2.items[0].dir)));
    await until(() => !emdx.state.awake);
    assert.ok(!fs.existsSync(path.join(dataDir, 'playlist', b1.items[0].dir)), 'files no longer needed are deleted');

    // "New photo for today" while it sleeps: rendered, but it has to wait for the display.
    await slotStart();
    const sends = emdx.received.length;
    await assert.rejects(app.next('manual'), /deep sleep, where Wake-on-LAN does not reach it\. It gets the playlist the next time it is online/);
    assert.equal(app.daily.due(), 'a new photo for now');
    const fresh = pl().slots[0];
    assert.notEqual(fresh.dir, pl().batch.items[0].dir);
    assert.equal(emdx.received.length, sends);
    // Someone presses its button and then Check display: that sends the playlist too.
    emdx.wake();
    await app.displayInfo();
    await until(() => pl().batch.items[0].dir === fresh.dir && !app.busy);
    await until(() => emdx.received.length === sends + 1);
    assert.ok(emdx.received.at(-1).images[0].equals(device(fresh.dir)));
    assert.equal(app.daily.due(), null);

    // The page and the status API show the plan.
    const status = await (await fetch('http://127.0.0.1:18461/api/status')).json();
    assert.equal(status.mode, 'playlist');
    assert.equal(status.playlist.slots.length, 4);
    assert.equal(status.playlist.slots.filter((s) => s.now).length, 1);
    assert.equal(status.playlist.batch.photos, pl().batch.items.length);
    const img = await fetch(`http://127.0.0.1:18461/img/playlist/${fresh.dir}/preview.jpg`);
    assert.equal(img.status, 200);
    const small = await fetch(`http://127.0.0.1:18461/img/playlist/${fresh.dir}/thumb.jpg`);
    assert.equal(small.status, 200);
    assert.ok((await small.arrayBuffer()).byteLength < 60000);
    assert.match(await (await fetch('http://127.0.0.1:18461/')).text(), /data-view="playlist"/);

    // A test pattern replaces the playlist: a fresh one is due.
    await until(() => !app.busy && !emdx.state.awake);
    emdx.wake();
    await app.testPattern();
    assert.match(app.daily.due(), /test pattern replaced the playlist/);

    // Another SCHEDULE: the plan follows the new change times.
    app.cancelSleep();
    await until(() => !app.busy);
    cfg.schedule = '*/15 * * * * *';
    const { DailyPlaylist } = await import('../src/daily.js');
    app.daily = new DailyPlaylist(app);
    await app.exclusive('test', () => app.daily.ensurePlan());
    const c2 = app.daily.clock;
    assert.equal(pl().slots.length, 4);
    for (let i = 1; i < 4; i++) assert.equal(pl().slots[i].at, c2.next(pl().slots[i - 1].at));
    app.state.playlist.pending = null;
    assert.equal(app.daily.due(), 'SCHEDULE changed');
  } finally {
    for (const k of ['PHOTO_DIR', 'UPDATE_MODE', 'PLAYLIST_DAYS', 'SCHEDULE', 'PANEL_WIDTH', 'PANEL_HEIGHT', 'WAKE_WINDOW_MIN', 'SLEEP_CHECK_MIN']) delete process.env[k];
  }
});

test('playlist mode: the display comes online after each change; the NAS reads the battery and leaves it alone, tops it up when it runs short, stops asking for thumbnails that never come, and serves the playlist again after a restart', { skip: !hasOpenssl && 'openssl not available', timeout: 180000 }, async () => {
  const { startFakeEmdx } = await import('./helpers/fakeEmdx.js');
  const emdx = await startFakeEmdx({ pin: '626262', thumbnails: false });
  emdx.state.wakeOnChangeMs = 6000;
  emdx.state.sleepsAfterUpdateMs = 1500;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-mornings-'));
  const photoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-mornings-photos-'));
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(photoDir, `p${String(i).padStart(2, '0')}.jpg`), await sharp(photoSvg(i)).jpeg({ quality: 85 }).toBuffer());
  Object.assign(process.env, {
    DATA_DIR: dataDir, ALBUM_URLS: '', PHOTO_DIR: photoDir, EMDX_HOST: '127.0.0.1', EMDX_PORT: String(emdx.port), EMDX_PIN: '626262',
    SERVER_HOST: '127.0.0.1', HTTP_PORT: '18462', PANEL_WIDTH: '640', PANEL_HEIGHT: '360', ORIENTATION: 'portrait',
    FETCH_TIMEOUT_SEC: '20', CONNECT_ATTEMPTS: '2', EMDX_MAC: emdx.mac, WOL_BROADCAST: '127.0.0.1', WOL_PORT: String(emdx.wolPort),
    WAKE_WAIT_SEC: '0.1', SLEEP_MODE: 'deep', SLEEP_DELAY_SEC: '1', WAKE_WINDOW_MIN: '0.1', SLEEP_CHECK_MIN: '0',
    UPDATE_MODE: 'playlist', PLAYLIST_DAYS: '3', PLAYLIST_TOPUP_DAYS: '2', SCHEDULE: '*/10 * * * * *', TZ,
  });
  try {
    const { loadConfig, DEVICE_PALETTE } = await import('../src/config.js');
    const { Store } = await import('../src/state.js');
    const { buildPaletteModel } = await import('../src/color.js');
    const { FrameApp } = await import('../src/app.js');
    const { createServer } = await import('../src/server.js');
    const cfg = loadConfig();
    Object.assign(cfg.update, { minFirstSec: 1, minTailSec: 0.2, watchEverySec: 0.3, thumbTimeoutSec: 1, quietSec: 0.5 });
    Object.assign(cfg.sleep, { confirmSec: 2, confirmEverySec: 0.2, ownSleepSec: 0 });
    Object.assign(cfg.display, { sleepWindowSec: 1, awakeWindowSec: 1 });
    const app = new FrameApp(cfg, new Store(dataDir), buildPaletteModel(cfg.image.measuredPalette, DEVICE_PALETTE));
    const server = createServer(cfg, app);
    app.server = server;
    await server.listen();
    cleanups.push(async () => { app.cancelSleep(); await server.close(); await emdx.close(); });
    const clock = app.daily.clock;
    const pl = () => app.state.playlist;
    const asks = () => emdx.events.filter((e) => e.startsWith('cmd:c7/54')).length;
    const powerOffs = () => emdx.events.filter((e) => e === 'cmd:11:0').length;
    const nextChange = async () => {
      await sleepMs(clock.next(Date.now()) - Date.now() + 100);
      await app.scheduled('schedule');
    };

    // The first playlist, sent when found awake (one thumbnail request, unanswered).
    await sleepMs(clock.next(Date.now()) - Date.now() + 600);
    await app.daily.startup();
    assert.equal(await app.checkAsleep(), true);
    assert.equal(app.state.wakeEvents[0].sent, 'playlist');
    assert.equal(asks(), 0); // (no playlist on it yet: nothing to compare a thumbnail with)
    await until(() => !emdx.state.awake);
    const first = pl().batch.sentAt;

    // Change 1: online after the change; 2 days still to come, so no top-up. The battery is read,
    // and the NAS sends no power-off command: the display goes back to sleep by itself.
    emdx.state.battery = 86;
    const offs = powerOffs();
    await nextChange();
    const c1 = pl().changes[0];
    assert.ok(c1.online, 'came online after the change');
    assert.equal(c1.battery, 86);
    assert.equal(app.state.wakeEvents[0].afterChange, true);
    assert.equal(app.state.wakeEvents[0].battery, 86);
    assert.equal(pl().batch.sentAt, first);
    assert.equal(app.state.batteryLog.at(-1).percent, 86);
    assert.equal(asks(), 1);
    await until(() => !emdx.state.awake);
    assert.equal(powerOffs(), offs);

    // Change 2: only 1 day left, so it gets a fresh playlist. (Thumbnail request 2.)
    emdx.state.battery = 85;
    await nextChange();
    assert.ok(pl().batch.sentAt > first);
    assert.equal(app.state.wakeEvents[0].sent, 'playlist');
    assert.equal(app.state.wakeEvents[0].battery, 85);
    assert.equal(asks(), 2);
    await until(() => !emdx.state.awake);

    // Change 3: request 3, still no thumbnail: from now on the NAS doesn't wait for them.
    await nextChange();
    assert.equal(asks(), 3);
    assert.equal(app.thumbnailsWork(), false);
    await until(() => !emdx.state.awake);
    await nextChange();
    assert.equal(asks(), 3);
    assert.ok(pl().changes[0].online);

    // The status shows the mornings: battery per change, and the after-change wakes as such.
    const status = await (await fetch('http://127.0.0.1:18462/api/status')).json();
    assert.equal(status.thumbnails, false);
    assert.ok(status.playlist.changes.slice(0, 3).every((c) => c.online && c.battery != null), JSON.stringify(status.playlist.changes));
    assert.ok(status.check === null || status.check.wakeEvents.every((e) => e.afterChange || e.sent));
    assert.equal(status.batteryDays[0].percent, 85); // (readings within half an hour: the latest)
    assert.equal(powerOffs(), 0, 'the display went to sleep by itself every time');

    // Awake and charging: the sleep check leaves it alone, also the second time.
    await sleepMs(Math.max(0, 600 - (Date.now() - clock.prev(Date.now()))));
    emdx.state.pluggedIn = true;
    emdx.wake();
    assert.equal(await app.checkAsleep(), true);
    assert.equal(await app.checkAsleep(), true);
    assert.deepEqual([app.state.wakeEvents[0].leftAlone, app.state.wakeEvents[0].charging, emdx.state.awake, powerOffs()], [true, true, true, 0]);
    emdx.state.pluggedIn = false;
    // Check display doesn't ask for a thumbnail any more either.
    await app.displayInfo();
    assert.equal(asks(), 3);
    assert.equal(app.state.displayCheck.thumbnail, undefined);

    // After a restart the NAS forgets what it served, unless it serves the playlist on the
    // display again, under the same addresses.
    const last = emdx.received.at(-1);
    const imageUrl = last.content.schedule[0].contents[1].image_url;
    const contentUrl = imageUrl.replace(/[^/]+$/, 'content.json');
    await server.close();
    await sleepMs(200); // (so that fetch notices the old connections are gone)
    const server2 = createServer(cfg, app);
    app.server = server2;
    await server2.listen();
    cleanups.push(() => server2.close());
    assert.equal((await fetch(contentUrl)).status, 404);
    await app.daily.startup();
    const manifest = await fetch(contentUrl);
    assert.equal(manifest.status, 200);
    assert.deepEqual(await manifest.json(), last.content);
    const img = await fetch(imageUrl);
    assert.equal(img.status, 200);
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(last.images[1]));
  } finally {
    for (const k of ['PHOTO_DIR', 'UPDATE_MODE', 'PLAYLIST_DAYS', 'PLAYLIST_TOPUP_DAYS', 'SCHEDULE', 'PANEL_WIDTH', 'PANEL_HEIGHT', 'WAKE_WINDOW_MIN', 'SLEEP_CHECK_MIN']) delete process.env[k];
  }
});
