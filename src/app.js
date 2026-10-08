// Orchestration: read the album, pick, download, render, push, remember.
import fs from 'node:fs';
import sharp from 'sharp';
import { log } from './log.js';
import { fetchAlbum, fetchItemInfo, sizedUrl, downloadImage } from './sources/googleAlbum.js';
import { scanFolder } from './sources/folder.js';
import { syncBag, planNext, markShown } from './selector.js';
import { composeCanvas, renderCanvas, planCells } from './render.js';
import { pushToDisplay } from './display.js';
import { renderTestPattern } from './testPattern.js';

const DAY = 24 * 3600 * 1000;

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
    const st = this.state;
    st.excluded ||= {};
    st.history ||= [];
  }

  get state() {
    return this.store.state;
  }

  async exclusive(what, fn) {
    if (this.busy) throw new Error(`Busy: ${this.busy.what}`);
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

  // ---------- the daily job ----------
  async scheduled() {
    clearTimeout(this.retryTimer);
    this.retryCount = 0;
    for (let i = 0; this.busy && i < 120; i++) await new Promise((r) => setTimeout(r, 5000));
    try {
      await this.next('schedule');
    } catch (err) {
      log.error('Scheduled update failed:', err);
    }
  }

  scheduleRetry() {
    if (this.retryCount >= this.cfg.retries) return;
    this.retryCount++;
    const mins = this.cfg.retryMinutes;
    log.info(`Will retry in ${mins} minutes (${this.retryCount}/${this.cfg.retries})`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.next('retry').catch((err) => log.error('Retry failed:', err));
    }, mins * 60 * 1000);
  }

  next(reason = 'manual') {
    return this.exclusive('Preparing the next photo', async () => {
      const st = this.state;
      if (reason === 'retry' && st.current && !st.current.pushed && fs.existsSync(this.store.path('current', 'device.png'))) {
        return this.push(st.current);
      }
      await this.prepare(reason);
      return this.push(st.current);
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

  async push(current) {
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
      const { battery } = await pushToDisplay(this.cfg, this.server, png);
      current.pushed = true;
      current.pushedAt = Date.now();
      if (battery) st.battery = { ...battery, at: Date.now() };
      markShown(st, current.ids);
      this.addHistory({ ok: true, kind: current.kind, ids: current.ids, dates: current.items.map((i) => i.takenAt) });
      st.lastError = null;
      this.retryCount = 0;
      this.store.save();
      return current;
    } catch (err) {
      this.addHistory({ ok: false, error: err.message });
      this.store.save();
      this.scheduleRetry();
      throw err;
    }
  }

  resend() {
    return this.exclusive('Sending again', async () => {
      if (!this.state.current) throw new Error('Nothing rendered yet');
      return this.push(this.state.current);
    });
  }

  testPattern({ push = true } = {}) {
    return this.exclusive('Test pattern', async () => {
      const { devicePng, previewPng } = await renderTestPattern(this.cfg, this.model);
      const dir = this.store.path('testpattern');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/device.png`, devicePng);
      fs.writeFileSync(`${dir}/preview.png`, previewPng);
      this.state.testPattern = { at: Date.now(), sent: false };
      this.store.save();
      if (push && this.cfg.display.host) {
        this.setBusy('Sending the test pattern');
        await pushToDisplay(this.cfg, this.server, devicePng);
        this.state.testPattern.sent = true;
        this.addHistory({ ok: true, kind: 'test pattern', ids: [], dates: [] });
        this.store.save();
      }
    });
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
    };
  }
}
