// Orchestration: read the album, pick, download, render, push, remember.
import fs from 'node:fs';
import sharp from 'sharp';
import { log } from './log.js';
import { fetchAlbum, fetchItemInfo, sizedUrl, downloadImage } from './sources/googleAlbum.js';
import { scanFolder } from './sources/folder.js';
import { syncBag, planNext, markShown } from './selector.js';
import { composeCanvas, renderCanvas, planCells } from './render.js';
import { pushToDisplay, putToSleep, readDisplayInfo, confirmAsleep, probeDisplay } from './display.js';
import { renderTestPattern } from './testPattern.js';

const DAY = 24 * 3600 * 1000;
// Runs that retry when the display can't be reached (manual ones report back instead).
const SCHEDULED = new Set(['schedule', 'retry', 'start']);

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
    const st = this.state;
    st.excluded ||= {};
    st.history ||= [];
  }

  get state() {
    return this.store.state;
  }

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

  // An action that talks to the display. It takes over from a pending sleep, and if
  // it fails with nothing to follow up, the display is still put back to sleep.
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

  // ---------- the daily job ----------
  async scheduled(reason = 'schedule') {
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

  next(reason = 'manual') {
    return this.run('Preparing the next photo', async () => {
      const st = this.state;
      if (reason === 'retry' && st.current && !st.current.pushed && fs.existsSync(this.store.path('current', 'device.png'))) {
        return this.push(st.current, { reason });
      }
      await this.prepare(reason);
      return this.push(st.current, { reason });
    });
  }

  async prepare(reason) {
    const st = this.state;
    const lib = await this.loadLibrary(reason === 'schedule' ? 0 : 30 * 60 * 1000);
    const byId = new Map(lib.items.map((it) => [it.id, it]));
    const ids = lib.items.map((it) => it.id);
    syncBag(st, ids);

    let plan = null;
    let inputs = null;
    for (let attempt = 0; attempt < 10 && !inputs; attempt++) {
      plan = planNext(this.cfg, st, byId);
      if (!plan) throw new Error('No usable photos in the album');
      if (await this.skipVideos(plan)) { syncBag(st, ids); continue; }
      try {
        this.setBusy('Downloading');
        inputs = await this.download(plan);
      } catch (err) {
        log.warn(`Skipping ${err.itemId} for a week: ${err.message}`);
        st.excluded[err.itemId] = { reason: 'download failed', until: Date.now() + 7 * DAY };
        syncBag(st, ids);
      }
    }
    if (!inputs) throw new Error('Could not download any photo (see log)');

    this.setBusy('Cropping and dithering');
    const canvas = await composeCanvas(this.cfg, plan, inputs);
    const out = await renderCanvas(this.cfg, this.model, canvas);
    const dir = this.store.path('current');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/device.png`, out.devicePng);
    fs.writeFileSync(`${dir}/preview.png`, out.previewPng);
    fs.writeFileSync(`${dir}/preview.jpg`, out.previewJpg);
    fs.rmSync(`${dir}/source-2.jpg`, { force: true });
    for (let i = 0; i < inputs.length; i++) {
      const thumb = await sharp(inputs[i], { failOn: 'none' }).rotate().resize(900, 900, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
      fs.writeFileSync(`${dir}/source-${i + 1}.jpg`, thumb);
    }
    st.current = {
      renderedAt: Date.now(),
      kind: plan.kind,
      ids: plan.items.map((it) => it.id),
      items: plan.items.map((it) => ({ id: it.id, takenAt: it.takenAt, source: it.source, album: it.album })),
      pushed: false,
      inkShare: out.inkShare,
    };
    this.store.save();
    log.info(`Rendered ${plan.kind} (${plan.items.length} photo${plan.items.length > 1 ? 's' : ''}) in ${out.ms} ms`);
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

  // How an update treats network standby and finds the display. Network standby is set
  // during each update (standby: on, deep: off), as the display may doze off by itself
  // before the NAS sends it to sleep. In deep sleep Wake-on-LAN doesn't reach it, so a
  // scheduled update waits WAKE_WINDOW_MIN for it to wake itself (its screen protection
  // time) instead of sending Wake-on-LAN.
  pushOptions(reason = 'manual') {
    const { mode, wakeWindowMin } = this.cfg.sleep;
    if (mode === 'off') return { networkStandby: null };
    if (mode === 'standby') return { networkStandby: true };
    return {
      networkStandby: false,
      connect: reason === 'schedule' ? { windowSec: wakeWindowMin * 60, wol: false, quiet: true } : {},
    };
  }

  // Say why a sleeping display could not be reached, and what to do about it.
  explainUnreachable(err, reason = 'manual') {
    const { mode, wakeWindowMin } = this.cfg.sleep;
    if (!err.unreachable || mode === 'off') return err;
    let hint;
    if (mode === 'deep') {
      hint = reason === 'schedule'
        ? `It did not wake by itself within ${wakeWindowMin} minutes: check that its screen protection time ` +
          '(Samsung E-Paper app) matches SCHEDULE. Pressing its power button wakes it for a few minutes: ' +
          'then press "Send again".'
        : 'It is in deep sleep, where Wake-on-LAN does not reach it: press its power button, then try again.';
    } else {
      hint = this.cfg.display.mac
        ? 'Wake-on-LAN did not wake it: check its battery and that its Network Standby is on ' +
          '(sleep-test checks the setup). Pressing its power button wakes it too.'
        : 'Set EMDX_MAC so the NAS can wake it from sleep with Wake-on-LAN.';
    }
    const e = new Error(`${err.what || err.message}. ${hint}`);
    e.unreachable = true;
    return e;
  }

  // We talked to the display, so whatever it was doing before, it is awake now.
  markAwake() {
    if (this.state.sleep) this.state.sleep.asleep = false;
  }

  async push(current, { reason = 'manual' } = {}) {
    const st = this.state;
    this.setBusy('Sending to the display');
    const png = fs.readFileSync(this.store.path('current', 'device.png'));
    if (!this.cfg.display.host) {
      // Dry run (no EMDX_HOST): render only, so you can preview the album in the web UI.
      log.info('EMDX_HOST not set: dry run, nothing sent to a display.');
      current.dryRun = true;
      markShown(st, current.ids);
      this.addHistory({ ok: true, kind: `${current.kind} (dry run)`, ids: current.ids, dates: current.items.map((i) => i.takenAt) });
      this.store.save();
      return current;
    }
    try {
      const opts = this.pushOptions(reason);
      if (opts.connect?.windowSec) log.info(`Waiting up to ${this.cfg.sleep.wakeWindowMin} min for the display to wake itself…`);
      const { battery, waitedSec } = await pushToDisplay(this.cfg, this.server, png, opts);
      current.pushed = true;
      current.pushedAt = Date.now();
      if (battery) st.battery = { ...battery, at: Date.now() };
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
      const e = this.explainUnreachable(err, reason);
      this.addHistory({ ok: false, error: e.message });
      this.store.save();
      // In deep sleep the display won't wake for a retry; a sleep check catches it awake.
      if (SCHEDULED.has(reason) && this.cfg.sleep.mode !== 'deep') this.scheduleRetry();
      throw e;
    }
  }

  // ---------- sleep ----------
  cancelSleep() {
    clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
  }

  // Put the display to sleep SLEEP_DELAY_SEC from now (time for the panel to redraw).
  scheduleSleep() {
    const { mode, delaySec } = this.cfg.sleep;
    if (mode === 'off' || !this.cfg.display.host) return;
    this.cancelSleep();
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

  // After a failed action: unless a retry follows or the display is out of reach
  // anyway, don't leave it awake.
  afterFailure(err) {
    if (err.busy || err.unreachable || this.retryTimer || this.believedAsleep()) return;
    this.scheduleSleep();
  }

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
    // Sends the sleep command (network standby on for standby, off for deep sleep), then
    // makes sure it worked: the display must stop answering (probed without Wake-on-LAN).
    // An awake display keeps using its battery, so a failure gets a second try. A display
    // that is out of reach already went to sleep by itself, with network standby as the
    // last update set it.
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
          if (battery?.batteryPercent != null) this.state.battery = { ...battery, at: Date.now() };
        } catch (err) {
          if (!err.unreachable) { problem = err.message; continue; }
          reached = false;
        }
        const after = reached ? await confirmAsleep(this.cfg, { timeoutSec: confirmSec, everySec: confirmEverySec }) : 0;
        if (after === null) { problem = `it still answered ${confirmSec} s after the power-off command`; continue; }
        const self = !reached && attempt === 1;
        this.state.sleep = { mode, asleep: true, sleptAt: Date.now(), self, confirmedAfter: after };
        const next = mode === 'deep' ? '. It wakes itself at its screen protection time'
          : this.cfg.display.mac ? '. Wake-on-LAN wakes it for the next update' : '';
        log.info(self ? 'The display had already gone to sleep by itself.'
          : `Display is asleep: it stopped answering ${after} s after the power-off command${next}.`);
        this.store.save();
        return;
      }
      const b = this.state.battery;
      const charging = b?.pluggedIn && Date.now() - b.at < 10 * 60000;
      const message = `The display did not go to sleep, after two tries: ${problem}. ` +
        (charging ? 'It is charging, so for now that costs no battery.' : 'Awake, it keeps using its battery.') +
        (checkMin ? ` The NAS tries again at its next sleep check (every ${checkMin} min).` : '');
      this.state.sleep = { mode, asleep: false, error: message, at: Date.now() };
      this.store.save();
      throw new Error(message);
    });
  }

  // ---------- sleep check ----------
  // Every SLEEP_CHECK_MIN minutes, unless the display is meant to be awake (an update, a
  // pending sleep or a pending retry) or a scheduled update is due within 20 minutes (in
  // deep sleep the display wakes itself for it), check that it is asleep: probe it without
  // Wake-on-LAN, so a sleeping display stays asleep. One that answers gets the photo that
  // is still waiting to be shown, if any; otherwise it is put back to sleep. Either way it
  // is noted.
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
    if (this.busy || this.sleepTimer || this.retryTimer || this.minutesToNextRun() < 20) return null;
    // Holding the lock: the display takes one connection at a time.
    const awake = await this.exclusive('Checking that the display is asleep', () => probeDisplay(this.cfg));
    const st = this.state;
    st.lastCheck = { at: Date.now(), awake };
    if (!awake) {
      this.store.save();
      return false;
    }
    const event = { at: Date.now(), wasAsleep: this.believedAsleep() };
    st.wakeEvents = [event, ...(st.wakeEvents || [])].slice(0, 20);
    this.markAwake();
    this.store.save();
    const waiting = this.photoWaiting();
    if (waiting) log.info('Sleep check: the display is awake and a photo is waiting; sending it.');
    else log.warn('Sleep check: the display is awake although it should be asleep; putting it back to sleep.');
    try {
      if (waiting) {
        await this.run('Sending the waiting photo', () => this.push(st.current, { reason: 'awake' }));
        event.sent = true; // it goes back to sleep SLEEP_DELAY_SEC later, as after any update
      } else {
        await this.sleepNow();
        event.putBack = true;
      }
    } finally {
      const b = st.battery; // read just now
      if (b?.at >= event.at) Object.assign(event, { battery: b.batteryPercent ?? null, charging: !!b.pluggedIn });
      this.store.save();
    }
    return true;
  }

  // A rendered photo that never reached the display (e.g. it slept through the update).
  photoWaiting() {
    const c = this.state.current;
    return !!c && !c.pushed && !c.dryRun && fs.existsSync(this.store.path('current', 'device.png'));
  }

  minutesToNextRun() {
    try {
      const t = this.cron?.nextRun();
      return t ? (t.getTime() - Date.now()) / 60000 : Infinity;
    } catch {
      return Infinity;
    }
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

  resend() {
    return this.run('Sending again', async () => {
      if (!this.state.current) throw new Error('Nothing rendered yet');
      return this.push(this.state.current, { reason: 'resend' });
    });
  }

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
          await pushToDisplay(this.cfg, this.server, devicePng, this.pushOptions());
        } catch (err) {
          if (!err.unreachable) this.markAwake();
          throw this.explainUnreachable(err, 'manual');
        }
        this.state.testPattern.sent = true;
        this.addHistory({ ok: true, kind: 'test pattern', ids: [], dates: [] });
        this.scheduleSleep();
        this.store.save();
      }
    });
  }

  // "Check display": read its name, firmware, battery and network standby. This wakes
  // it (Wake-on-LAN), so it is sent back to sleep SLEEP_DELAY_SEC later.
  displayInfo() {
    return this.exclusive('Checking the display', async () => {
      const info = await readDisplayInfo(this.cfg);
      this.markAwake();
      this.scheduleSleep();
      if (info.battery?.batteryPercent != null) this.state.battery = { ...info.battery, at: Date.now() };
      this.state.displayCheck = { ...info, at: Date.now() };
      this.store.save();
      return info;
    });
  }

  // Put the display to sleep now (instead of waiting for SLEEP_DELAY_SEC).
  async sleepRightAway() {
    this.cancelSleep();
    await this.sleepNow();
  }

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
      current: st.current || null,
      nextRun,
      battery: st.battery || null,
      cycle: st.cycle ? { n: st.cycle, shown: (st.shownThisCycle || []).length, total: (st.shownThisCycle || []).length + (st.bag || []).length } : null,
      library: lib ? { count: lib.items.length, fetchedAt: lib.fetchedAt, titles: lib.albums.map((a) => a.title + (a.stale ? ' (cached)' : '')) } : null,
      lastError: st.lastError || null,
      history: st.history.slice(0, 10),
      testPattern: st.testPattern || null,
      dither: this.cfg.image.dither,
      sleep: this.cfg.display.host ? this.sleepStatus() : null,
      displayCheck: st.displayCheck || null,
      check: this.cfg.display.host && this.cfg.sleep.mode !== 'off' && this.cfg.sleep.checkMin
        ? { everyMin: this.cfg.sleep.checkMin, last: st.lastCheck || null, wakeEvents: (st.wakeEvents || []).slice(0, 10) }
        : null,
    };
  }

  sleepStatus() {
    const { mode } = this.cfg.sleep;
    const z = this.state.sleep?.mode === mode ? this.state.sleep : {}; // ignore state from another SLEEP_MODE
    return { ...z, mode, pending: !!this.sleepTimer, asleep: this.believedAsleep() };
  }
}
