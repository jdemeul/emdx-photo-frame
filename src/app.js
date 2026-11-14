// The service: reads the album, picks and renders photos, sends them to the display and puts it
// to sleep. In push mode (UPDATE_MODE=push) the NAS sends one photo at every SCHEDULE time, from
// here; in playlist mode it sends the coming days at once and the display changes the photo
// itself (daily.js).
import fs from 'node:fs';
import { log } from './log.js';
import { markShown } from './selector.js';
import { pushToDisplay, readDisplayInfo, probeDisplay } from './display.js';
import { renderTestPattern } from './testPattern.js';
import { DailyPlaylist } from './daily.js';
import { notify } from './notify.js';
import { Library } from './library.js';
import { Sleep } from './sleep.js';
import { Cleaning } from './cleaning.js';
import { Checks } from './checks.js';

const DAY = 24 * 3600 * 1000;
const LOW_BATTERY = 20; // percent
// Runs that retry when the display can't be reached (manual ones report back instead).
const SCHEDULED = new Set(['schedule', 'retry', 'start']);
// How long an action waits for a quick look at the display to finish: a look can take its
// connection timeout, a battery and a cleaning-time read, and the disconnect (~30 s at worst).
const PROBE_WAIT_MS = 40000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export class FrameApp {
  constructor(cfg, store, model) {
    this.cfg = cfg;
    this.store = store;
    this.model = model;
    this.busy = null;
    this.server = null; // set by index.js
    this.cron = null; // set by index.js
    this.retryCount = 0;
    this.retryTimer = null;
    this.sleepTimer = null;
    this.watchTimer = null;
    this.missedTimer = null;
    upgradeState(this.state);
    store.save();
    this.daily = cfg.update.mode === 'playlist' ? new DailyPlaylist(this) : null;
  }

  get state() {
    return this.store.state;
  }

  // One thing at a time: the display takes one connection at a time, and the album and the
  // renders are shared. `probe`: a quick look at the display (sleep checks), which anything else
  // waits for (seconds) instead of failing as busy.
  async exclusive(what, fn, { probe = false } = {}) {
    if (this.busy?.probe && !probe) {
      for (const end = Date.now() + PROBE_WAIT_MS; this.busy?.probe && Date.now() < end;) await pause(200);
    }
    if (this.busy) {
      const err = new Error(`Busy: ${this.busy.what}`);
      err.busy = true;
      throw err;
    }
    this.busy = { what, since: Date.now(), ...(probe ? { probe: true } : {}) };
    try {
      return await fn();
    } catch (err) {
      this.state.lastError = { at: Date.now(), message: err.message };
      this.store.save();
      throw err;
    } finally {
      this.busy = null;
    }
  }

  setBusy(what) {
    if (this.busy) this.busy.what = what;
    log.info(`${what}…`);
  }

  // An action that talks to the display. It takes over from a pending sleep, and if it fails
  // with nothing to follow up, the display is still put back to sleep.
  async run(what, fn) {
    try {
      return await this.exclusive(what, () => {
        this.cancelSleep();
        return fn();
      });
    } catch (err) {
      this.afterFailure(err);
      throw err;
    }
  }

  // ---------- push mode: one photo per SCHEDULE time ----------
  async scheduled(reason = 'schedule') {
    if (this.daily) return this.daily.scheduled(reason).catch((err) => log.error('Playlist:', err));
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryCount = 0;
    for (let i = 0; this.busy && i < 120; i++) await new Promise((r) => setTimeout(r, 5000));
    try {
      await this.next(reason);
    } catch (err) {
      log.error('Scheduled update failed:', err);
    }
  }

  scheduleRetry() {
    if (this.retryCount >= this.cfg.retries) return false;
    this.retryCount++;
    const mins = this.cfg.retryMinutes;
    log.info(`Will retry in ${mins} minutes (${this.retryCount}/${this.cfg.retries})`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.next('retry').catch((err) => log.error('Retry failed:', err));
    }, mins * 60 * 1000);
    return true;
  }

  // "Next photo now" (playlist mode: "New photo for today").
  next(reason = 'manual') {
    if (this.daily) return this.daily.newPhotoNow();
    return this.run('Preparing the next photo', async () => {
      const st = this.state;
      if (reason === 'retry' && this.photoWaiting()) return this.push(st.current, { reason });
      await this.prepare(reason);
      return this.push(st.current, { reason });
    });
  }

  async prepare(reason) {
    const meta = await this.renderPhoto(this.store.path('current'), { fresh: reason === 'schedule' });
    this.state.current = { ...meta, pushed: false };
    this.store.save();
  }

  // "Send again" (playlist mode: "Send playlist").
  resend() {
    if (this.daily) return this.run('Sending the playlist', () => this.daily.send('resend'));
    return this.run('Sending again', async () => {
      if (!this.state.current) throw new Error('Nothing rendered yet');
      return this.push(this.state.current, { reason: 'resend' });
    });
  }

  // Network standby is set during each update (standby: on, deep: off), as the display may
  // doze off by itself before the NAS sends it to sleep.
  networkStandby() {
    return { standby: true, deep: false, off: null }[this.cfg.sleep.mode];
  }

  async push(current, { reason = 'manual' } = {}) {
    const st = this.state;
    this.setBusy('Sending to the display');
    const png = fs.readFileSync(this.store.path('current', 'device.png'));
    if (!this.cfg.display.host) {
      // Dry run (no EMDX_HOST): render only, so you can preview the album on the page.
      log.info('EMDX_HOST not set: dry run, nothing sent to a display.');
      current.dryRun = true;
      markShown(st, current.ids);
      this.addHistory({ ok: true, kind: `${current.kind} (dry run)`, ids: current.ids, dates: current.items.map((i) => i.takenAt) });
      this.store.save();
      return current;
    }
    try {
      const { battery, waitedSec } = await pushToDisplay(this.cfg, this.server, png, {
        networkStandby: this.networkStandby(),
        connect: await this.deepSleepConnect(reason),
      });
      current.pushed = true;
      current.pushedAt = Date.now();
      this.noteBattery(battery);
      markShown(st, current.ids);
      this.addHistory({
        ok: true, kind: current.kind, ids: current.ids, dates: current.items.map((i) => i.takenAt),
        battery: battery?.batteryPercent ?? null, waited: waitedSec ?? undefined,
      });
      st.lastError = null;
      this.retryCount = 0;
      clearTimeout(this.retryTimer); // a pending retry would skip a photo now
      this.retryTimer = null;
      this.scheduleSleep();
      this.store.save();
      return current;
    } catch (err) {
      if (!err.unreachable) this.markAwake();
      const e = this.explainUnreachable(err);
      this.addHistory({ ok: false, error: e.message });
      this.store.save();
      // In deep sleep a retry wouldn't reach it either; the sleep check catches it awake.
      if (SCHEDULED.has(reason) && this.cfg.sleep.mode !== 'deep') this.scheduleRetry();
      throw e;
    }
  }

  // In deep sleep nothing on the network wakes the display, so don't spend minutes on Wake-on-LAN:
  // a scheduled run looks once; a button on the page waits a little for a display that is just
  // waking up (someone pressed its power button). Returns connect options for pushContent().
  async deepSleepConnect(reason) {
    if (this.cfg.sleep.mode !== 'deep' || reason === 'light sleep') return {};
    // Just found awake, and maybe not for long: no Wake-on-LAN (and no wait for it to work) first.
    if (['awake', 'found awake', 'after a change', 'after a missed change', 'check display'].includes(reason)) return { wol: false };
    if (!SCHEDULED.has(reason)) return { windowSec: this.cfg.display.awakeWindowSec, wol: false, quiet: true };
    if (await probeDisplay(this.cfg)) return {};
    throw Object.assign(new Error('Could not reach the display'), { unreachable: true });
  }

  // Say why a sleeping display could not be reached, and what to do about it.
  explainUnreachable(err) {
    const { mode } = this.cfg.sleep;
    if (!err.unreachable || mode === 'off') return err;
    let hint;
    if (mode === 'deep') {
      hint = this.daily
        ? 'It is in deep sleep, where Wake-on-LAN does not reach it. It gets the playlist the next time it is online: after its next change, or after a press on its power button.'
        : 'It is in deep sleep, where Wake-on-LAN does not reach it: the photo goes out when the NAS next finds it awake (press its power button). On battery, UPDATE_MODE=playlist lets the display change photos by itself.';
    } else {
      hint = this.cfg.display.mac
        ? 'Wake-on-LAN did not wake it: check its battery and that its Network Standby is on '
          + '(sleep-test checks the setup). Pressing its power button wakes it too.'
        : 'Set EMDX_MAC so the NAS can wake it from sleep with Wake-on-LAN.';
    }
    const e = new Error(`${err.what || err.message}. ${hint}`);
    e.unreachable = true;
    return e;
  }

  // A rendered photo that never reached the display (e.g. it slept through the update).
  photoWaiting() {
    const c = this.state.current;
    return !!c && !c.pushed && !c.dryRun && fs.existsSync(this.store.path('current', 'device.png'));
  }

  // A battery reading (from any conversation with the display): the latest is shown on the
  // page, and one per half hour goes into the battery log (the morning readings in playlist
  // mode show the daily drain).
  noteBattery(battery) {
    if (battery?.batteryPercent == null) return;
    const at = Date.now();
    this.state.battery = { ...battery, at };
    addBatteryReading(this.state.batteryLog, { at, percent: battery.batteryPercent, charging: !!battery.pluggedIn });
    if (battery.batteryPercent < LOW_BATTERY && !battery.pluggedIn) this.alert('battery', 'battery low', `The battery is at ${battery.batteryPercent}%: charge the display. An empty battery stops the photo from changing.`);
    else if (battery.pluggedIn || battery.batteryPercent >= LOW_BATTERY + 10) this.clearAlert('battery', `The battery is at ${battery.batteryPercent}%${battery.pluggedIn ? ', charging' : ''}.`);
  }

  // ---------- when the frame needs a hand ----------
  // Something a person has to do something about (a missed change, a low battery, a display that
  // won't go into deep sleep): noted once, and sent to NOTIFY_URL if that is set. clearAlert()
  // when it is over.
  alert(key, title, text) {
    const alerts = (this.state.alerts ||= {});
    if (alerts[key]) return;
    alerts[key] = { at: Date.now(), text };
    this.store.save();
    notify(this.cfg, `${this.cfg.frame?.name ?? 'Photo frame'}: ${title}`, text);
  }

  clearAlert(key, text) {
    if (!this.state.alerts?.[key]) return;
    delete this.state.alerts[key];
    this.store.save();
    if (text) notify(this.cfg, `${this.cfg.frame?.name ?? 'Photo frame'}: back to normal`, text);
  }

  // The one line at the top of the page: is the frame fine, and if not, what to do about it.
  // Returns { level: 'ok' | 'warn' | 'bad', text }, the most urgent thing first.
  health(now = Date.now()) {
    const st = this.state;
    const pl = this.daily?.st;
    if (!this.cfg.display.host) return { level: 'warn', text: 'Dry run: EMDX_HOST is not set, so nothing is sent to a display.' };
    const miss = this.daily?.missedOpen();
    if (miss) return { level: 'bad', text: `The photo did not change${miss.count > 1 ? ` at the last ${miss.count} changes` : ''}: the display did not come online. Press its power button; it then gets a fresh playlist by itself.` };
    const b = st.battery;
    if (b && b.batteryPercent < LOW_BATTERY && !b.pluggedIn) return { level: 'bad', text: `Battery at ${b.batteryPercent}%: charge the display.` };
    const ls = st.lightSleep;
    if (ls?.gaveUp && !ls.endedAt) return { level: 'bad', text: 'The display is asleep but stays on the Wi-Fi, which drains its battery, and the NAS could not get it into deep sleep. Press its power button and leave it alone; if it stays on the Wi-Fi, restart it.' };
    if (this.sleepStatus().error) return { level: 'warn', text: this.sleepStatus().error };
    if (this.daily && !pl.batch) return { level: 'warn', text: 'The display has no playlist yet: press its power button, then Send playlist.' };
    if (this.daily && now >= pl.batch.endsAt) return { level: 'warn', text: 'The playlist on the display has run out, so it repeats old photos. Press its power button: it then gets a fresh one.' };
    if (!this.daily && this.photoWaiting()) return { level: 'warn', text: 'A photo is waiting: the display could not be reached. It goes out when the NAS next finds the display awake.' };
    if (this.ownSleep() && st.displayCheck?.sleepAfter === 'off') return { level: 'warn', text: `Sleep After was off on the display when last checked (${new Date(st.displayCheck.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: this.cfg.timezone })}): it then stays awake and uses its battery. Set it to 10 minutes in the Samsung E-Paper app, then press Check display.` };
    if (st.lastError && now - st.lastError.at < DAY) return { level: 'warn', text: st.lastError.message };
    const ch = pl?.changes?.[0];
    const made = ch?.online ? `The display changed the photo at ${new Date(ch.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: this.cfg.timezone })}` : null;
    return { level: 'ok', text: [made || 'All fine', b ? `battery ${b.batteryPercent}%${b.pluggedIn ? ' (charging)' : ''}` : null].filter(Boolean).join(' · ') };
  }

  // ---------- test pattern and display check ----------
  testPattern({ push = true } = {}) {
    return this.run('Test pattern', async () => {
      const { devicePng, previewPng } = await renderTestPattern(this.cfg, this.model);
      const dir = this.store.path('testpattern');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/device.png`, devicePng);
      fs.writeFileSync(`${dir}/preview.png`, previewPng);
      this.state.testPattern = { at: Date.now(), sent: false };
      this.store.save();
      if (push && this.cfg.display.host) {
        this.setBusy('Sending the test pattern');
        try {
          const { battery } = await pushToDisplay(this.cfg, this.server, devicePng, { networkStandby: this.networkStandby() });
          this.noteBattery(battery);
        } catch (err) {
          if (!err.unreachable) this.markAwake();
          throw this.explainUnreachable(err);
        }
        this.state.testPattern.sent = true;
        this.daily?.replaced('the test pattern');
        this.addHistory({ ok: true, kind: 'test pattern', ids: [], dates: [] });
        this.scheduleSleep();
        this.store.save();
      }
    });
  }

  // "Check display": read its name, firmware, battery and settings. This wakes it (Wake-on-LAN),
  // so it goes back to sleep afterwards. In playlist mode, a display that is awake for this gets a fresh playlist if one
  // is due.
  async displayInfo() {
    const info = await this.exclusive('Checking the display', async () => {
      const read = await readDisplayInfo(this.cfg);
      this.markAwake();
      this.scheduleSleep();
      this.noteBattery(read.battery);
      this.noteCleaning(read.cleaning);
      this.state.displayCheck = { ...read, at: Date.now() };
      this.store.save();
      return read;
    });
    if (this.daily) this.daily.sendIfDue('check display').catch((err) => log.warn(`Playlist: ${err.message}`));
    return info;
  }

  // ---------- history and status ----------
  addHistory(entry) {
    const st = this.state;
    st.history.unshift({ at: Date.now(), ...entry });
    st.history.length = Math.min(st.history.length, 50);
  }

  status() {
    const st = this.state;
    const lib = st.library;
    let nextRun = null;
    try { nextRun = this.cron?.nextRun()?.toISOString() || null; } catch { /* ignore */ }
    return {
      frame: this.cfg.frame ?? null,
      health: this.health(),
      busy: this.busy,
      mode: this.cfg.update.mode,
      playlist: this.daily ? this.daily.status() : null,
      current: st.current || null,
      nextRun,
      battery: st.battery || null,
      batteryDays: batteryDays(st.batteryLog, this.cfg.timezone),
      cycle: st.cycle ? { n: st.cycle, shown: (st.shownThisCycle || []).length, total: (st.shownThisCycle || []).length + (st.bag || []).length } : null,
      library: lib ? { count: lib.items.length, fetchedAt: lib.fetchedAt, titles: lib.albums.map((a) => a.title + (a.stale ? ' (cached)' : '')) } : null,
      lastError: st.lastError || null,
      history: st.history.slice(0, 10),
      testPattern: st.testPattern || null,
      dither: this.cfg.image.dither,
      sleep: this.cfg.display.host ? this.sleepStatus() : null,
      deepSleep: st.deepSleep || null,
      lightSleep: st.lightSleep || null,
      cleaning: this.cfg.display.host ? this.cleaningStatus() : null,
      displayCheck: st.displayCheck || null,
      check: this.cfg.display.host && this.cfg.sleep.mode !== 'off' && this.cfg.sleep.checkMin
        ? { everyMin: this.cfg.sleep.checkMin, last: st.lastCheck || null, wakeEvents: (st.wakeEvents || []).filter((e) => !e.afterChange).slice(0, 10), missedEverySec: this.missedTimer ? this.cfg.sleep.missedCheckSec : null }
        : null,
      displayTraffic: this.server?.recentTraffic?.(this.cfg.display.host).slice(0, 20) ?? [],
    };
  }

  sleepStatus() {
    const { mode } = this.cfg.sleep;
    const z = this.state.sleep?.mode === mode ? this.state.sleep : {}; // ignore state from another SLEEP_MODE
    return { ...z, mode, pending: !!this.sleepTimer, asleep: this.believedAsleep() };
  }
}

// The battery log keeps one reading per half hour (the latest), 200 at most.
function addBatteryReading(logEntries, entry) {
  const last = logEntries.at(-1);
  if (last && entry.at - last.at < 30 * 60000) logEntries[logEntries.length - 1] = entry;
  else logEntries.push(entry);
  if (logEntries.length > 200) logEntries.splice(0, logEntries.length - 200);
}

// The first battery reading of each of the last 7 days (in playlist mode: the one taken when
// the display came online after the morning change), newest first.
export function batteryDays(logEntries, timezone, days = 7) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' });
  const seen = new Map();
  for (const e of logEntries || []) {
    const day = fmt.format(new Date(e.at)).replace(',', '');
    if (!seen.has(day)) seen.set(day, { day, at: e.at, percent: e.percent, charging: e.charging });
  }
  return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, days);
}

// State written by earlier versions: drop what the playlist test left (saying so if it was cut
// short and left the display's settings changed), drop what screen thumbnails left (until 8 Nov
// 2026), label old wake-ups, and start the battery log from the readings in the history.
export function upgradeState(st) {
  st.excluded ||= {};
  st.history ||= [];
  const saved = st.pendingRestore || (st.playlistTest && !st.playlistTest.done ? st.playlistTest.saved : null);
  if (saved) {
    const message = 'A playlist test was cut short and left the display\'s Sleep After (and "apply sleep mode after content update") as the test set them: set them back in the Samsung E-Paper app.';
    log.warn(message);
    st.lastError = { at: Date.now(), message };
    if (st.playlist) st.playlist.pending = 'the playlist test replaced the playlist';
  }
  for (const e of st.wakeEvents || []) {
    if (e.sent !== true) continue;
    const playlist = st.history.some((h) => h.ok && /^playlist sent/.test(h.kind || '') && h.at >= e.at && h.at - e.at < 10 * 60000);
    e.sent = playlist ? 'playlist' : 'photo';
  }
  if (!st.batteryLog) {
    st.batteryLog = [];
    const readings = [
      ...st.history.filter((h) => h.ok && h.battery != null).map((h) => ({ at: h.at, percent: h.battery, charging: false })),
      ...(st.wakeEvents || []).filter((e) => e.battery != null).map((e) => ({ at: e.at, percent: e.battery, charging: !!e.charging })),
    ].sort((a, b) => a.at - b.at);
    for (const r of readings) addBatteryReading(st.batteryLog, r);
  }
  for (const key of ['playlistTest', 'pendingRestore', 'thumbnailFailures', 'thumbs', 'thumbnail']) delete st[key];
  if (st.playlist) delete st.playlist.seen;
  if (st.playlist?.missed) delete st.playlist.missed.seen;
  if (st.displayCheck) delete st.displayCheck.thumbnail;
}

// FrameApp's methods live in several files, by subject: add them to the class.
for (const part of [Library, Sleep, Cleaning, Checks]) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name !== 'constructor') Object.defineProperty(FrameApp.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
  }
}
