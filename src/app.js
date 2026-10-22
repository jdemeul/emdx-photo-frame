// The service: reads the album, picks and renders photos, sends them to the display and puts it
// to sleep. In push mode (UPDATE_MODE=push) the NAS sends one photo at every SCHEDULE time, from
// here; in playlist mode it sends the coming days at once and the display changes the photo
// itself (daily.js).
import fs from 'node:fs';
import sharp from 'sharp';
import { log } from './log.js';
import { fetchAlbum, fetchItemInfo, sizedUrl, downloadImage } from './sources/googleAlbum.js';
import { scanFolder } from './sources/folder.js';
import { syncBag, planNext, markShown } from './selector.js';
import { composeCanvas, renderCanvas, planCells } from './render.js';
import { pushToDisplay, putToSleep, readDisplayInfo, confirmAsleep, probeDisplay, lookForDisplay, withDisplay, requestThumbnail } from './display.js';
import { renderTestPattern } from './testPattern.js';
import { DailyPlaylist } from './daily.js';

const DAY = 24 * 3600 * 1000;
// Runs that retry when the display can't be reached (manual ones report back instead).
const SCHEDULED = new Set(['schedule', 'retry', 'start']);
// After this many requests without a single thumbnail, stop waiting for them: the firmware
// doesn't send any (the EM32DX's doesn't). Check display still asks, without waiting.
const THUMB_TRIES = 3;

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
    this.thumbWaiters = new Set(); // callers waiting for the display's next thumbnail
    upgradeState(this.state);
    store.save();
    this.daily = cfg.update.mode === 'playlist' ? new DailyPlaylist(this) : null;
  }

  get state() {
    return this.store.state;
  }

  // One thing at a time: the display takes one connection at a time, and the album and the
  // renders are shared.
  async exclusive(what, fn) {
    if (this.busy) {
      const err = new Error(`Busy: ${this.busy.what}`);
      err.busy = true;
      throw err;
    }
    this.busy = { what, since: Date.now() };
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

  // ---------- photo library ----------
  refreshLibrary() {
    return this.exclusive('Reading the album', () => this.loadLibrary(0));
  }

  async loadLibrary(maxAgeMs) {
    const cfg = this.cfg;
    const cached = this.state.library;
    if (cached?.items?.length && maxAgeMs && Date.now() - cached.fetchedAt < maxAgeMs) return cached;

    const items = [];
    const albums = [];
    const errors = [];
    for (const url of cfg.albumUrls) {
      try {
        const a = await fetchAlbum(url);
        albums.push({ url, title: a.title, count: a.items.length });
        for (const it of a.items) items.push({ ...it, source: 'google', key: a.key, albumUrl: url, album: a.title });
        log.info(`Album "${a.title}": ${a.items.length} photos`);
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
        log.error(`Could not read album ${url}:`, err);
        // Keep using what we knew about this album.
        const old = (cached?.items || []).filter((it) => it.albumUrl === url);
        if (old.length) {
          log.warn(`Using ${old.length} cached photos for that album`);
          items.push(...old);
          albums.push({ url, title: old[0].album || 'Shared album', count: old.length, stale: true });
        }
      }
    }
    if (cfg.photoDir) {
      const { items: files, cache } = await scanFolder(cfg.photoDir, this.state.folderCache || {});
      this.state.folderCache = cache;
      for (const it of files) items.push({ ...it, source: 'folder', album: 'Folder' });
      albums.push({ url: cfg.photoDir, title: 'Folder', count: files.length });
    }
    if (!items.length) {
      throw new Error(errors.length ? errors.join(' | ') : 'No photos found. Set ALBUM_URLS (and/or PHOTO_DIR).');
    }
    this.state.library = { fetchedAt: Date.now(), albums, items, errors };
    this.store.save();
    return this.state.library;
  }

  // Pick the next photo(s) from the album, download, crop and render them into `dir`
  // (device.png for the display, previews, a thumbnail and the originals for the page).
  // Returns what was rendered; marking it as shown is up to the caller. `fresh`: read the
  // album anew. `say`: reports progress (default: the busy label).
  async renderPhoto(dir, { fresh = false, say = (what) => this.setBusy(what) } = {}) {
    const st = this.state;
    const lib = await this.loadLibrary(fresh ? 0 : 30 * 60 * 1000);
    const byId = new Map(lib.items.map((it) => [it.id, it]));
    const ids = lib.items.map((it) => it.id);
    const avoid = this.daily?.plannedIds() ?? []; // a new round shouldn't open with these
    const sync = () => syncBag(st, ids, undefined, undefined, avoid);
    sync();

    let plan = null;
    let inputs = null;
    for (let attempt = 0; attempt < 10 && !inputs; attempt++) {
      plan = planNext(this.cfg, st, byId);
      if (!plan) throw new Error('No usable photos in the album');
      if (await this.skipVideos(plan)) { sync(); continue; }
      try {
        say('Downloading');
        inputs = await this.download(plan);
      } catch (err) {
        log.warn(`Skipping ${err.itemId} for a week: ${err.message}`);
        st.excluded[err.itemId] = { reason: 'download failed', until: Date.now() + 7 * DAY };
        sync();
      }
    }
    if (!inputs) throw new Error('Could not download any photo (see log)');

    say('Cropping and dithering');
    const canvas = await composeCanvas(this.cfg, plan, inputs);
    const out = await renderCanvas(this.cfg, this.model, canvas);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/device.png`, out.devicePng);
    fs.writeFileSync(`${dir}/preview.png`, out.previewPng);
    fs.writeFileSync(`${dir}/preview.jpg`, out.previewJpg);
    fs.writeFileSync(`${dir}/thumb.jpg`, await sharp(out.previewJpg).resize(240).jpeg({ quality: 80 }).toBuffer());
    fs.rmSync(`${dir}/source-2.jpg`, { force: true });
    for (let i = 0; i < inputs.length; i++) {
      const thumb = await sharp(inputs[i], { failOn: 'none' }).rotate().resize(900, 900, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
      fs.writeFileSync(`${dir}/source-${i + 1}.jpg`, thumb);
    }
    log.info(`Rendered ${plan.kind} (${plan.items.length} photo${plan.items.length > 1 ? 's' : ''}) in ${out.ms} ms`);
    return {
      renderedAt: Date.now(),
      kind: plan.kind,
      ids: plan.items.map((it) => it.id),
      items: plan.items.map((it) => ({ id: it.id, takenAt: it.takenAt, source: it.source, album: it.album })),
      inkShare: out.inkShare,
    };
  }

  // Videos in the album: look up file names and skip them (best effort).
  async skipVideos(plan) {
    const byKey = new Map();
    for (const it of plan.items) {
      if (it.source !== 'google' || this.state.checked?.[it.id]) continue;
      if (!byKey.has(it.key)) byKey.set(it.key, []);
      byKey.get(it.key).push(it.id);
    }
    let skipped = false;
    for (const [key, ids] of byKey) {
      try {
        const info = await fetchItemInfo(key, ids);
        this.state.checked ||= {};
        for (const id of ids) {
          const i = info.get(id);
          if (!i) continue;
          this.state.checked[id] = 1;
          if (i.isVideo) {
            log.info(`Skipping video ${i.filename}`);
            this.state.excluded[id] = { reason: 'video', until: null };
            skipped = true;
          }
        }
      } catch (err) {
        log.debug(`Video check unavailable: ${err.message}`);
      }
    }
    return skipped;
  }

  async download(plan) {
    const cells = planCells(this.cfg, plan);
    const inputs = [];
    for (let i = 0; i < plan.items.length; i++) {
      const it = plan.items[i];
      const { w, h } = cells[i].rect;
      try {
        inputs.push(it.source === 'folder' ? fs.readFileSync(it.path) : await downloadImage(sizedUrl(it, w, h)));
      } catch (err) {
        err.itemId = it.id;
        throw err;
      }
    }
    return inputs;
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
    if (this.cfg.sleep.mode !== 'deep' || ['awake', 'found awake', 'after a change', 'check display'].includes(reason)) return {};
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

  // ---------- sleep ----------
  // We talked to the display, so whatever it was doing before, it is awake now.
  markAwake() {
    if (this.state.sleep) this.state.sleep.asleep = false;
  }

  cancelSleep() {
    clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
  }

  // Playlist mode with deep sleep: the display goes to sleep by itself, and the NAS sends it no
  // power-off command. On an EM32DX that command (sent right after a change, on 20 Oct 2026)
  // left it asleep but on the Wi-Fi for days, at about 1.5% battery an hour; after going to
  // sleep by itself following an update it was off the Wi-Fi until the next change.
  ownSleep() {
    return !!this.daily && this.cfg.sleep.mode === 'deep';
  }

  // Put the display to sleep SLEEP_DELAY_SEC from now (time for the panel to redraw), or with
  // ownSleep(), leave that to the display (the sleep check notes when it has gone to sleep).
  scheduleSleep() {
    const { mode, delaySec } = this.cfg.sleep;
    if (mode === 'off' || !this.cfg.display.host) return;
    this.cancelSleep();
    if (this.ownSleep()) {
      this.state.sleep = { mode, asleep: false, own: true, at: Date.now() };
      return;
    }
    this.state.sleep = { mode, asleep: false, sleepAt: Date.now() + delaySec * 1000 };
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      this.sleepNow().catch((err) => log.warn(`Could not put the display to sleep: ${err.message}`));
    }, delaySec * 1000);
  }

  believedAsleep() {
    const z = this.state.sleep;
    return !!z?.asleep && z.mode === this.cfg.sleep.mode;
  }

  // After a failed action: unless a retry follows or the display is out of reach anyway,
  // don't leave it awake.
  afterFailure(err) {
    if (err.busy || err.unreachable || this.retryTimer || this.believedAsleep()) return;
    this.scheduleSleep();
  }

  // Send the sleep command (network standby on for standby, off for deep sleep), then make
  // sure it worked: the display must stop answering (probed without Wake-on-LAN). An awake
  // display keeps using its battery, so a failure gets a second try. A display that is out of
  // reach already went to sleep by itself, with network standby as the last update set it.
  async sleepNow() {
    if (this.busy) { // something else is talking to the display; try again shortly
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.sleepNow().catch((err) => log.warn(`Could not put the display to sleep: ${err.message}`));
      }, 30000);
      return;
    }
    const { mode, confirmSec, confirmEverySec, checkMin } = this.cfg.sleep;
    const pause = (sec) => new Promise((r) => setTimeout(r, sec * 1000));
    return this.exclusive('Putting the display to sleep', async () => {
      let problem = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (problem) {
          log.warn(`The display did not go to sleep (${problem}); trying again.`);
          await pause(confirmEverySec);
        }
        let reached = true;
        try {
          const { battery } = await putToSleep(this.cfg, { networkStandby: mode === 'standby' });
          this.noteBattery(battery);
        } catch (err) {
          if (!err.unreachable) { problem = err.message; continue; }
          reached = false;
        }
        const after = reached ? await confirmAsleep(this.cfg, { timeoutSec: confirmSec, everySec: confirmEverySec }) : 0;
        if (after === null) { problem = `it still answered ${confirmSec} s after the power-off command`; continue; }
        const self = !reached && attempt === 1;
        this.state.sleep = { mode, asleep: true, sleptAt: Date.now(), self, confirmedAfter: after };
        const next = mode === 'deep' ? (this.daily ? '. It changes the photo by itself' : '')
          : this.cfg.display.mac ? '. Wake-on-LAN wakes it for the next update' : '';
        log.info(self ? 'The display had already gone to sleep by itself.'
          : `Display is asleep: it stopped answering ${after} s after the power-off command${next}.`);
        this.store.save();
        return;
      }
      const b = this.state.battery;
      const charging = b?.pluggedIn && Date.now() - b.at < 10 * 60000;
      const message = `The display did not go to sleep, after two tries: ${problem}. `
        + (charging ? 'It is charging, so for now that costs no battery.' : 'Awake, it keeps using its battery.')
        + (checkMin ? ` The NAS tries again at its next sleep check (every ${checkMin} min).` : '');
      this.state.sleep = { mode, asleep: false, error: message, at: Date.now() };
      this.store.save();
      throw new Error(message);
    });
  }

  // "Sleep now" (/api/sleep): put the display to sleep without waiting for SLEEP_DELAY_SEC.
  async sleepRightAway() {
    this.cancelSleep();
    await this.sleepNow();
  }

  // For one-shot commands: wait for the pending sleep instead of exiting before it.
  async flushSleep() {
    if (!this.sleepTimer) return;
    const wait = Math.max(0, (this.state.sleep?.sleepAt ?? Date.now()) - Date.now());
    this.cancelSleep();
    log.info(`Waiting ${Math.round(wait / 1000)} s for the panel to finish, then putting it to sleep…`);
    await new Promise((r) => setTimeout(r, wait));
    await this.sleepNow();
  }

  // ---------- sleep check ----------
  // Every SLEEP_CHECK_MIN minutes, unless the display is meant to be awake (an update, a pending
  // sleep or a pending retry), check that it is asleep: probe it without Wake-on-LAN, so a
  // sleeping display stays asleep. One that answers (someone pressed its power button, it is
  // charging) gets the photo that is still waiting to be shown, or in playlist mode a fresh
  // playlist if one is due; otherwise it is put back to sleep. Either way it is noted, with its
  // battery. In playlist mode the display also wakes up by itself and goes back to sleep by
  // itself: the check leaves it alone around a change, and puts it back to sleep only when it
  // was already awake at the previous check.
  startSleepWatch() {
    const { mode, checkMin } = this.cfg.sleep;
    if (!checkMin || mode === 'off' || !this.cfg.display.host) return;
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => {
      this.checkAsleep().catch((err) => log.warn(`Sleep check: ${err.message}`));
    }, checkMin * 60000);
  }

  stopSleepWatch() {
    clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  async checkAsleep() {
    if (this.busy || this.sleepTimer || this.retryTimer || this.daily?.nearChange()) return null;
    const own = this.state.sleep?.own && !this.state.sleep.asleep ? this.state.sleep : null;
    if (own && Date.now() - own.at < this.cfg.sleep.ownSleepSec * 1000) return null; // (give it time to go to sleep)
    const { awake, battery, network } = await this.exclusive('Checking that the display is asleep', () => lookForDisplay(this.cfg, { battery: true }));
    const st = this.state;
    const prev = st.lastCheck;
    st.lastCheck = { at: Date.now(), awake, network: awake ? 'on' : network };
    if (!awake) {
      // Believed awake, but it doesn't answer: it went to sleep by itself. Either way, note
      // whether it is still on the Wi-Fi.
      const z = st.sleep;
      if (z && !z.asleep && z.mode === this.cfg.sleep.mode) st.sleep = { mode: z.mode, asleep: true, sleptAt: Date.now(), self: true };
      if (st.sleep?.asleep && network) st.sleep.network = network;
      this.store.save();
      return false;
    }
    const event = this.noteWake();
    this.noteBattery(battery);
    try {
      if (this.daily) {
        let sent = false;
        try {
          sent = await this.daily.onAwake('found awake');
        } catch (err) {
          log.warn(`Sleep check: could not send the playlist: ${err.message}`);
          event.error = err.message;
          if (err.busy || err.unreachable || this.sleepTimer) return true; // (a failed send already scheduled the sleep)
        }
        if (sent) {
          event.sent = 'playlist'; // it goes back to sleep after the update, as always
          return true;
        }
        // (Awake at the previous check too, and not sent to sleep since.)
        const { checkMin } = this.cfg.sleep;
        const stillAwake = prev?.awake && !(st.sleep?.sleptAt > prev.at) && (!checkMin || event.at - prev.at <= 2 * checkMin * 60000);
        const charging = !!battery?.pluggedIn;
        if ((!stillAwake || charging) && !event.error) {
          log.info(charging ? 'Sleep check: the display is awake and charging; leaving it alone.'
            : 'Sleep check: the display is awake and its playlist is up to date; it goes back to sleep by itself (if it is still awake at the next check, the NAS sends it to sleep).');
          event.leftAlone = true;
          return true;
        }
        if (!event.error) log.info('Sleep check: the display is still awake and its playlist is up to date; putting it back to sleep.');
      } else if (this.photoWaiting()) {
        log.info('Sleep check: the display is awake and a photo is waiting; sending it.');
        await this.run('Sending the waiting photo', () => this.push(this.state.current, { reason: 'awake' }));
        event.sent = 'photo';
        return true;
      } else {
        log.warn('Sleep check: the display is awake although it should be asleep; putting it back to sleep.');
      }
      await this.sleepNow();
      event.putBack = true;
      return true;
    } finally {
      this.finishWake(event);
    }
  }

  // The display was found awake: note when (the battery reading taken meanwhile is added by
  // finishWake). `extra`: e.g. { afterChange: true }.
  noteWake(extra = {}) {
    const event = { at: Date.now(), wasAsleep: this.believedAsleep(), ...extra };
    this.state.wakeEvents = [event, ...(this.state.wakeEvents || [])].slice(0, 30);
    this.markAwake();
    this.store.save();
    return event;
  }

  finishWake(event) {
    const b = this.state.battery;
    if (b?.at >= event.at) Object.assign(event, { battery: b.batteryPercent ?? null, charging: !!b.pluggedIn });
    this.store.save();
  }

  // A battery reading (from any conversation with the display): the latest is shown on the
  // page, and one per half hour goes into the battery log (the morning readings in playlist
  // mode show the daily drain).
  noteBattery(battery) {
    if (battery?.batteryPercent == null) return;
    const at = Date.now();
    this.state.battery = { ...battery, at };
    addBatteryReading(this.state.batteryLog, { at, percent: battery.batteryPercent, charging: !!battery.pluggedIn });
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

  // "Check display": read its name, firmware, battery and settings, and ask for a thumbnail of
  // its screen (unless it never sends one). This wakes it (Wake-on-LAN), so it goes back to sleep
  // afterwards. In playlist mode, a display that is awake for this gets a fresh playlist if one
  // is due.
  async displayInfo() {
    const info = await this.exclusive('Checking the display', async () => {
      const thumbnailUrl = this.thumbnailsWork() === false ? null : this.server?.thumbnailUrl;
      const read = await readDisplayInfo(this.cfg, { thumbnailUrl });
      if (read.thumbnail === 'asked') this.state.thumbs.asked++;
      this.markAwake();
      this.scheduleSleep();
      this.noteBattery(read.battery);
      this.state.displayCheck = { ...read, at: Date.now() };
      this.store.save();
      return read;
    });
    if (this.daily) this.daily.sendIfDue('check display').catch((err) => log.warn(`Playlist: ${err.message}`));
    return info;
  }

  // ---------- thumbnails of the screen ----------
  // Does this display send thumbnails of its screen (MDC 0xC7/0x54)? null: not known yet.
  thumbnailsWork() {
    const t = this.state.thumbs;
    return t.received > 0 ? true : t.asked >= THUMB_TRIES ? false : null;
  }

  // Ask the display for a thumbnail and wait for it; null if none came (or none ever comes).
  async askThumbnail(timeoutSec = 10) {
    if (!this.server || this.thumbnailsWork() === false) return null;
    let deliver;
    const got = new Promise((resolve) => { deliver = resolve; });
    this.thumbWaiters.add(deliver);
    const timer = setTimeout(() => { this.thumbWaiters.delete(deliver); deliver(null); }, timeoutSec * 1000);
    try {
      await withDisplay(this.cfg, { quiet: true }, (device) => requestThumbnail(device, this.server.thumbnailUrl));
      this.state.thumbs.asked++; // (counted once the display has taken the request)
      const th = await got;
      if (!th && this.thumbnailsWork() === false) log.info(`No thumbnail after ${THUMB_TRIES} requests: this display doesn't send them; not asking any more.`);
      return th;
    } finally {
      clearTimeout(timer);
      this.thumbWaiters.delete(deliver);
      this.store.save();
    }
  }

  // A thumbnail the display POSTed: kept as thumbnails/latest.*, handed to whoever asked for it,
  // and in playlist mode matched against the photos.
  onThumbnail(th) {
    const st = this.state;
    st.thumbs.received++;
    if (th.image?.buf?.length) {
      const ext = /png/i.test(th.image.type || '') || /\.png$/i.test(th.image.name || '') ? 'png' : 'jpg';
      const dir = this.store.path('thumbnails');
      fs.mkdirSync(dir, { recursive: true });
      th.file = `latest.${ext}`;
      fs.writeFileSync(`${dir}/${th.file}`, th.image.buf);
      fs.rmSync(`${dir}/latest.${ext === 'png' ? 'jpg' : 'png'}`, { force: true });
    }
    st.thumbnail = { at: th.at, fields: th.fields, file: th.file || null };
    this.store.save();
    const waiters = [...this.thumbWaiters];
    this.thumbWaiters.clear();
    for (const w of waiters) w(th);
    if (!waiters.length && this.daily) this.daily.noteThumbnail(th, 'check display').catch((err) => log.warn(`Playlist: ${err.message}`));
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
      displayCheck: st.displayCheck || null,
      check: this.cfg.display.host && this.cfg.sleep.mode !== 'off' && this.cfg.sleep.checkMin
        ? { everyMin: this.cfg.sleep.checkMin, last: st.lastCheck || null, wakeEvents: (st.wakeEvents || []).filter((e) => !e.afterChange).slice(0, 10) }
        : null,
      thumbnails: this.thumbnailsWork(),
      thumbnail: st.thumbnail || null,
      displayTraffic: this.server?.recentTraffic?.().slice(0, 20) ?? [],
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
// short and left the display's settings changed), count its unanswered thumbnail requests (so the
// NAS doesn't keep waiting for thumbnails that never come), label old wake-ups, and start the
// battery log from the readings in the history.
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
  if (!st.thumbs) {
    const misses = (st.playlistTest?.observations || []).filter((o) => o.error).length
      + (st.playlist?.seen || []).filter((e) => e.note === 'no thumbnail came back').length;
    st.thumbs = st.thumbnail ? { asked: 0, received: 1 } : { asked: misses, received: 0 };
  }
  if (!st.batteryLog) {
    st.batteryLog = [];
    const readings = [
      ...st.history.filter((h) => h.ok && h.battery != null).map((h) => ({ at: h.at, percent: h.battery, charging: false })),
      ...(st.wakeEvents || []).filter((e) => e.battery != null).map((e) => ({ at: e.at, percent: e.battery, charging: !!e.charging })),
    ].sort((a, b) => a.at - b.at);
    for (const r of readings) addBatteryReading(st.batteryLog, r);
  }
  for (const key of ['playlistTest', 'pendingRestore', 'thumbnailFailures']) delete st[key];
}
