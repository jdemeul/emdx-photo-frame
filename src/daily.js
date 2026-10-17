// UPDATE_MODE=playlist: the NAS sends the photos for the coming PLAYLIST_DAYS days at once, as
// the display's own playlist, and the display changes the photo by itself at every SCHEDULE
// time, while it sleeps. The NAS renders the photos ahead (one per change: a "slot"), and
// sends a fresh playlist whenever it finds the display awake and the display has moved on
// since the last one (or something changed): after someone pressed its button, while it
// charges, or if it turns out to come online by itself after a change. Each fresh playlist
// starts with the photo for now, so the frame keeps its photo until the next change.
//
// State (state.playlist):
//   slots    the plan: [{ key, at, dir, kind, ids, items, renderedAt, inkShare }], one per
//            change from the one showing now; rendered files in <DATA_DIR>/playlist/<dir>/
//   batch    what the display got last: { builtAt, sentAt, items: [slot + durationMs], tail,
//            endsAt, count }
//   pending  why a fresh playlist should go out at the next chance (or null)
//   changes  the last changes: when the NAS looked for the display afterwards, and whether it
//            came online
//   seen     what thumbnails of the screen showed, matched against the photos
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from './log.js';
import { markShown } from './selector.js';
import { pushContent, probeDisplay } from './display.js';
import { changeClock, slotKey, dayLabel, buildBatch, positionAt } from './playlist.js';
import { matchThumbnail } from './thumbMatch.js';

const FILES = ['device.png', 'preview.png', 'preview.jpg', 'source-1.jpg', 'source-2.jpg'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;

export class DailyPlaylist {
  constructor(app) {
    this.app = app;
    this.cfg = app.cfg;
    this.clock = changeClock(app.cfg.schedule, app.cfg.timezone);
    const st = app.state;
    st.playlist ||= {};
    const p = st.playlist;
    p.slots ||= [];
    p.batch ||= null;
    p.pending ||= null;
    p.changes ||= [];
    p.seen ||= [];
    // Changes more than a day apart, or several a day: say the time too.
    const [a, b] = this.clock.upcoming(2, Date.now());
    this.withTime = !(b - a >= 20 * 3600000 && b - a <= 28 * 3600000);
  }

  get st() {
    return this.app.state.playlist;
  }

  label(t) {
    return dayLabel(t, this.cfg.timezone, this.withTime);
  }

  file(slot, name) {
    return this.app.store.path('playlist', slot.dir, name);
  }

  // ---------- the plan ----------
  // Make sure there is a photo for the slot showing now and for each of the next PLAYLIST_DAYS
  // changes, rendering what is missing. Runs inside the caller's lock. `fresh`: read the album
  // anew first. If a photo can't be prepared (album or network down), the plan stays short
  // and this tries again next time; it only throws when there is no photo for now at all.
  // Returns how many slots were added.
  async ensurePlan({ fresh = false } = {}) {
    const now = Date.now();
    const curAt = this.clock.prev(now) ?? now;
    // One change after the other, chained the way the playlist's durations are.
    const wanted = [curAt];
    while (wanted.length <= this.cfg.update.days) {
      const t = this.clock.next(wanted.at(-1));
      if (t == null || t <= wanted.at(-1)) break;
      wanted.push(t);
    }
    const have = new Map(this.st.slots.filter((s) => fs.existsSync(this.file(s, 'device.png'))).map((s) => [s.at, s]));
    const missing = wanted.filter((at) => !have.has(at));
    // Exactly the wanted slots (after a SCHEDULE change, photos planned for other times go).
    const keep = () => { this.st.slots = wanted.map((at) => have.get(at)).filter(Boolean); };
    let made = 0;
    let error = null;
    for (const at of missing) {
      try {
        const slot = (at === curAt && this.adoptCurrent(at))
          || await this.renderSlot(at, { fresh: fresh && made === 0, note: missing.length > 1 ? ` (${made + 1} of ${missing.length})` : '' });
        have.set(at, slot);
        made++;
        keep();
        this.app.store.save(); // progress survives a restart
      } catch (err) {
        error = err;
        log.warn(`Playlist: could not prepare the photo for ${this.label(at)}: ${err.message}`);
        break;
      }
    }
    keep();
    this.prune();
    this.app.store.save();
    if (made) log.info(`Playlist: photos ready for ${this.label(wanted[0])} to ${this.label(this.st.slots.at(-1).at)} (${made} new).`);
    if (error && !have.has(curAt)) throw error;
    return made;
  }

  // The photos planned or on the display: a new round of the album shouldn't start with them.
  plannedIds() {
    return [...this.st.slots, ...(this.st.batch?.items || [])].flatMap((s) => s.ids || []);
  }

  // The photo on the frame (rendered earlier, e.g. before switching to playlist mode) becomes
  // the photo for now, so the first playlist doesn't change it.
  adoptCurrent(at) {
    const c = this.app.state.current;
    const src = this.app.store.path('current');
    if (!c || c.dryRun || !fs.existsSync(path.join(src, 'device.png'))) return null;
    const slot = this.newSlot(at, { kind: c.kind, ids: c.ids, items: c.items, renderedAt: c.renderedAt, inkShare: c.inkShare ?? null });
    const dir = this.app.store.path('playlist', slot.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of FILES) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    markShown(this.app.state, c.ids || []); // (a photo still waiting to be shown wasn't marked yet)
    return slot;
  }

  newSlot(at, meta) {
    const key = slotKey(at, this.cfg.timezone);
    return { key, at, dir: `${key.replace(/\D/g, '')}-${crypto.randomBytes(3).toString('hex')}`, ...meta };
  }

  async renderSlot(at, { fresh = false, note = '' } = {}) {
    const app = this.app;
    const slot = this.newSlot(at, {});
    const what = `Preparing the photo for ${this.label(at)}${note}`;
    app.setBusy(what);
    const say = (step) => { if (app.busy) app.busy.what = `${what}: ${step.toLowerCase()}`; };
    const meta = await app.renderPhoto(app.store.path('playlist', slot.dir), { fresh, say });
    markShown(app.state, meta.ids); // planned: don't pick it again this round
    return Object.assign(slot, meta);
  }

  // Delete the files of photos that are neither planned nor in the playlist the display has.
  prune() {
    const keep = new Set([...this.st.slots.map((s) => s.dir), ...(this.st.batch?.items || []).map((it) => it.dir)]);
    const root = this.app.store.path('playlist');
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return; }
    for (const d of dirs) if (!keep.has(d)) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  }

  // ---------- sending ----------
  // Why a fresh playlist should go to the display at the next chance, or null.
  due(now = Date.now()) {
    const p = this.st;
    if (p.pending) return p.pending;
    if (!p.batch) return 'the display has no playlist yet';
    if (p.batch.schedule !== this.cfg.schedule) return 'SCHEDULE changed';
    if (p.batch.days !== this.cfg.update.days) return 'PLAYLIST_DAYS changed';
    const curAt = this.clock.prev(now);
    if (curAt != null && curAt > p.batch.items[0].at) return 'the display has moved on since the last playlist';
    return null;
  }

  // Send the playlist: the photo for now until the next change, then one photo per change for
  // PLAYLIST_DAYS days. Runs inside the caller's lock (app.run).
  async send(reason = 'manual') {
    const app = this.app;
    const cfg = this.cfg;
    await this.ensurePlan();
    if (!cfg.display.host) {
      log.info('EMDX_HOST not set: dry run, no playlist sent.');
      this.advance(Date.now(), { planOnly: true });
      return null;
    }
    // In deep sleep nothing on the network wakes the display: don't spend minutes trying
    // (unless the caller has just seen it awake).
    const sawIt = ['found awake', 'after a change', 'check display'].includes(reason);
    if (cfg.sleep.mode === 'deep' && !sawIt && !(await probeDisplay(cfg))) {
      const e = new Error(`The display is in deep sleep, where Wake-on-LAN does not reach it. Press its power button: within ${cfg.sleep.checkMin || 'a few'} minutes the NAS finds it awake and sends the playlist (or press "Send playlist" then).`);
      e.unreachable = true;
      app.addHistory({ ok: false, error: `Playlist not sent: ${e.message}` });
      app.store.save();
      throw e;
    }
    const now = Date.now();
    const batch = buildBatch({ now, slots: this.st.slots, clock: this.clock, minFirstMs: cfg.update.minFirstSec * 1000, minTailMs: cfg.update.minTailSec * 1000 });
    if (!batch) throw new Error('No photo planned for now');
    const seq = [...batch.items, ...(batch.tail ? [batch.tail] : [])];
    app.setBusy(`Sending the playlist (${seq.length} photos)`);
    const first = batch.items[0];
    const when = (t) => dayLabel(t, cfg.timezone, true);
    log.info(`Playlist: sending ${batch.items.length} photos: ${first.at > now ? `${this.label(first.at)}'s photo (a little early)` : 'the photo for now'} until ${when(first.to)}, `
      + `then one per change until ${when(batch.endsAt)}. If no fresh playlist arrives by then, the display starts over.`);
    const { mode } = cfg.sleep;
    try {
      const { battery } = await pushContent(cfg, app.server, {
        items: seq.map((it) => ({ file: this.file(it, 'device.png'), durationMs: it.durationMs })),
        contentType: 'PlaylistContent',
        name: 'Daily photos',
      }, {
        networkStandby: mode === 'standby' ? true : mode === 'deep' ? false : null,
      });
      const strip = ({ key, at, dir, kind, ids, items, renderedAt, inkShare, durationMs }) => ({ key, at, dir, kind, ids, items, renderedAt, inkShare, durationMs });
      this.st.batch = {
        builtAt: batch.builtAt, sentAt: Date.now(), reason, schedule: cfg.schedule, days: cfg.update.days,
        items: batch.items.map(strip), tail: batch.tail ? strip(batch.tail) : null, endsAt: batch.endsAt, count: seq.length,
      };
      this.st.pending = null;
      this.st.replaced = null;
      if (battery) app.state.battery = { ...battery, at: Date.now() };
      app.addHistory({ ok: true, kind: `playlist sent: ${batch.items.length} photos, until ${this.label(batch.endsAt)}`, ids: [], dates: [], battery: battery?.batteryPercent ?? null });
      app.state.lastError = null;
      this.advance(Date.now(), { sent: true });
      app.scheduleSleep();
      this.prune();
      app.store.save();
      log.info(`Playlist: the display has it, and changes the photo by itself at every change (next: ${dayLabel(this.clock.next(Date.now()), cfg.timezone, true)}).`);
      return this.st.batch;
    } catch (err) {
      if (!err.unreachable) app.markAwake();
      const e = app.explainUnreachable(err, 'manual');
      app.addHistory({ ok: false, error: `Playlist not sent: ${e.message}` });
      app.store.save();
      throw e;
    }
  }

  // ---------- what the display shows ----------
  // Bring state.current (the page's "On the frame") in line with the photo the display should
  // show now, going by the last playlist it got. `planOnly`: no playlist sent (dry run); show
  // the plan's photo for now. Returns the new current photo if it changed.
  advance(now = Date.now(), { sent = false, planOnly = false } = {}) {
    const app = this.app;
    const st = app.state;
    if (this.st.replaced && !sent) return null; // the display shows something else
    let item = null;
    let pos = null;
    if (this.st.batch && !planOnly) {
      pos = positionAt(this.st.batch, now);
      item = pos.item;
    } else if (planOnly) {
      item = this.st.slots.find((s) => s.at <= now && this.clock.next(s.at) > now) || null;
    }
    if (!item || !fs.existsSync(this.file(item, 'device.png'))) return null;
    const c = st.current;
    if (c?.slotDir === item.dir && !sent) return null;
    const dst = app.store.path('current');
    fs.mkdirSync(dst, { recursive: true });
    for (const f of FILES) {
      const from = this.file(item, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, f));
      else fs.rmSync(path.join(dst, f), { force: true });
    }
    const changed = c?.slotDir !== item.dir;
    st.current = {
      renderedAt: item.renderedAt, kind: item.kind, ids: item.ids, items: item.items, inkShare: item.inkShare ?? null,
      pushed: !planOnly, pushedAt: this.st.batch?.sentAt ?? null, dryRun: planOnly && !this.cfg.display.host,
      slotKey: item.key, slotDir: item.dir, since: pos ? (sent ? now : pos.since) : now, byDisplay: !sent && !planOnly, loop: pos?.loop ?? 0,
    };
    return changed ? st.current : null;
  }

  // ---------- the daily rhythm ----------
  // Cron, at each change: note the display's new photo, prepare the photo for the new last day,
  // then look for the display for a while (does it come online after a change?).
  async scheduled(reason) {
    const app = this.app;
    if (reason === 'start') return this.startup({ send: true });
    await this.whenIdle();
    try {
      await app.exclusive('Playlist: the display moves on', async () => {
        if (this.st.replaced) log.info(`Playlist: a change time, but ${this.st.replaced.what} replaced the playlist; it comes back when the NAS next finds the display awake.`);
        const cur = this.advance();
        if (cur) {
          const loop = cur.loop ? ` (repeating: playlist round ${cur.loop + 1})` : '';
          const taken = (cur.items || []).map((i) => (i.takenAt ? new Date(i.takenAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: this.cfg.timezone }) : 'date unknown'));
          log.info(`Playlist: the display should now show ${this.label(this.clock.prev(Date.now()))}'s photo (${cur.kind}${taken.length ? `, taken ${taken.join(' + ')}` : ''})${loop}.`);
          app.addHistory({ ok: true, kind: `${cur.kind}, changed by the display (expected)${loop}`, ids: cur.ids, dates: cur.items.map((i) => i.takenAt) });
        } else if (!this.st.batch) {
          log.info('Playlist: a change time, but the display has no playlist yet.');
        }
        app.store.save();
        await this.ensurePlan({ fresh: true });
      });
    } catch (err) {
      log.warn(`Playlist: ${err.message}`);
    }
    if (this.cfg.display.host) {
      if (this.cfg.sleep.mode === 'standby') await this.sendIfDue('schedule'); // Wake-on-LAN can reach it
      else await this.watchAfterChange();
    }
  }

  async whenIdle(maxMs = 10 * 60000) {
    for (const end = Date.now() + maxMs; this.app.busy && Date.now() < end;) await pause(1000);
  }

  async sendIfDue(reason) {
    const why = this.due();
    if (!why) return false;
    try {
      await this.app.run('Sending the playlist', () => this.send(reason));
      return true;
    } catch (err) {
      log.warn(`Playlist not sent (${why}): ${err.message}`);
      return false;
    }
  }

  // Probe (no Wake-on-LAN) every watchEverySec for WAKE_WINDOW_MIN after a change. If the
  // display comes online, see what it shows and send a fresh playlist if one is due. (The sleep
  // check may find it first: it notes that in this.watch, and handles the display itself.)
  async watchAfterChange() {
    const app = this.app;
    const cfg = this.cfg;
    const start = Date.now();
    const rec = { at: start, key: slotKey(this.clock.prev(start) ?? start, cfg.timezone), until: start + cfg.sleep.wakeWindowMin * 60000, online: null };
    this.st.changes = [rec, ...this.st.changes].slice(0, 10);
    app.store.save();
    log.info(`Playlist: looking for the display for ${cfg.sleep.wakeWindowMin} min (without Wake-on-LAN), to see whether it comes online after a change…`);
    let mine = false;
    this.watch = rec;
    try {
      while (Date.now() < rec.until && !rec.online) {
        // (Not while it is awake because of something the NAS did, e.g. a playlist just sent.)
        if (!app.busy && !app.sleepTimer) {
          let awake = false;
          try { awake = await app.exclusive('Looking for the display after the change', () => probeDisplay(cfg)); } catch { /* busy */ }
          if (awake && !rec.online) { rec.online = Date.now(); mine = true; break; }
        }
        await pause(cfg.update.watchEverySec * 1000);
      }
    } finally {
      this.watch = null;
    }
    app.store.save();
    if (!rec.online) {
      log.info(`Playlist: the display did not come online within ${cfg.sleep.wakeWindowMin} min of the change${cfg.sleep.mode === 'deep' ? ' (expected in deep sleep: it changes the photo offline)' : ''}.`);
      return;
    }
    log.info(`Playlist: the display came online ${Math.round((rec.online - start) / 1000)} s after the change${mine ? '' : ' (found by the sleep check)'}.`);
    if (!mine) return;
    app.markAwake();
    app.state.wakeEvents = [{ at: rec.online, afterChange: true }, ...(app.state.wakeEvents || [])].slice(0, 20);
    let sent = false;
    try { sent = await this.onAwake('after a change'); } catch (err) { log.warn(`Playlist: ${err.message}`); }
    if (!sent && cfg.sleep.mode !== 'off') await app.sleepNow().catch((err) => log.warn(`Could not put the display to sleep: ${err.message}`));
  }

  // The display answers (button, charger, or by itself after a change): note what it shows,
  // and send a fresh playlist if one is due. Returns true if it sent one.
  async onAwake(how, { look = true } = {}) {
    if (look) await this.observe(how).catch((err) => log.debug(`No thumbnail: ${err.message}`));
    const why = this.due();
    if (!why) return false;
    log.info(`Playlist: the display is awake (${how}); sending a fresh playlist (${why}).`);
    await this.app.run('Sending the playlist', () => this.send(how));
    return true;
  }

  // Ask for a thumbnail of the screen and match it against the photos.
  async observe(how) {
    const app = this.app;
    if (!app.server || !this.st.batch) return null;
    const th = await app.exclusive('Asking the display what it shows', () => app.askThumbnail(this.cfg.update.thumbTimeoutSec));
    return this.noteThumbnail(th, how);
  }

  async noteThumbnail(th, how) {
    const b = this.st.batch;
    const at = th?.at ?? Date.now();
    const expected = b ? positionAt(b, at).item : null;
    // The display starts counting once it has the playlist (and has drawn the first photo: about
    // a minute on the EM32DX), so right after a change it may still show the photo before.
    const lagging = b ? positionAt(b, at - (b.sentAt - b.builtAt) - 120000).item : null;
    const entry = { at, how, expected: expected?.key ?? null, seen: null };
    if (th?.image?.buf?.length && b) {
      const cands = new Map();
      for (const s of [...b.items, ...this.st.slots]) cands.set(s.dir, { key: s.key, file: this.file(s, 'preview.jpg') });
      const m = await matchThumbnail(th.image.buf, [...cands.values()]);
      if (m) Object.assign(entry, { seen: m.key, score: m.score, sure: m.sure, file: th.file ?? null });
      entry.ok = !!m && (m.key === entry.expected || m.key === lagging?.key);
    } else {
      entry.note = th ? 'thumbnail without an image' : 'no thumbnail came back';
    }
    this.st.seen = [entry, ...this.st.seen].slice(0, 10);
    this.app.store.save();
    if (entry.seen) {
      const name = (key) => { const s = [...(b?.items || []), ...this.st.slots].find((x) => x.key === key); return s ? this.label(s.at) : key; };
      const ok = entry.seen === entry.expected ? ', as expected' : entry.ok ? ', the one before the last change (it changes a little after the change time)' : `; expected ${name(entry.expected)}'s`;
      log.info(`Playlist: the display shows ${entry.sure ? '' : 'probably '}${name(entry.seen)}'s photo (match ${entry.score})${ok}.`);
    } else {
      log.debug(`Playlist: ${entry.note}`);
    }
    return entry;
  }

  // ---------- buttons ----------
  // "New photo for today": replace the photo for now, then send the playlist (or, if the
  // display can't be reached, at the next chance).
  newPhotoNow() {
    return this.app.run('New photo for now', async () => {
      await this.ensurePlan();
      const curAt = this.clock.prev(Date.now()) ?? Date.now();
      const slot = await this.renderSlot(curAt, {});
      this.st.slots = [...this.st.slots.filter((s) => s.at !== curAt), slot].sort((x, y) => x.at - y.at);
      this.st.pending = 'a new photo for now';
      this.prune();
      this.app.store.save();
      log.info(`Playlist: new photo for now (${slot.kind}); sending the playlist.`);
      return this.send('manual');
    });
  }

  // At startup: catch up with what the display shows, prepare the coming photos, and say
  // what happens next. With RUN_ON_START, also try to send the playlist.
  async startup({ send = false } = {}) {
    const app = this.app;
    try {
      await app.exclusive('Preparing the coming photos', async () => {
        this.advance();
        await this.ensurePlan();
      });
    } catch (err) {
      log.warn(`Playlist: could not prepare the coming photos: ${err.message}`);
      return;
    }
    const why = this.due();
    if (send && why) await this.sendIfDue('start');
    else if (why && this.cfg.display.host) {
      log.info(`Playlist: a fresh playlist is due (${why}). It goes out when the NAS finds the display awake`
        + `${this.cfg.sleep.checkMin ? ` (it looks every ${this.cfg.sleep.checkMin} min; press the display's power button to wake it)` : ''}, or press "Send playlist".`);
    }
  }

  // The test pattern (or anything else sent as a single image) replaced the playlist.
  replaced(what) {
    this.st.pending = `${what} replaced the playlist`;
    this.st.replaced = { what, at: Date.now() };
    this.app.store.save();
  }

  status() {
    const now = Date.now();
    const b = this.st.batch;
    const pos = b ? positionAt(b, now) : null;
    const sent = new Set(b ? b.items.map((it) => it.dir) : []);
    const nowDir = pos?.item.dir ?? this.st.slots.find((s) => s.at <= now && this.clock.next(s.at) > now)?.dir;
    return {
      days: this.cfg.update.days,
      nextChange: this.clock.next(now),
      due: this.due(now),
      batch: b ? {
        sentAt: b.sentAt, count: b.count, photos: b.items.length, endsAt: b.endsAt, first: b.items[0].key, tail: !!b.tail,
        loop: pos.loop, ranOut: now >= b.endsAt,
      } : null,
      slots: this.st.slots.map((s) => ({
        key: s.key, at: s.at, dir: s.dir, label: this.label(s.at), kind: s.kind,
        dates: (s.items || []).map((i) => i.takenAt ?? null), sent: sent.has(s.dir), now: s.dir === nowDir,
      })),
      replaced: this.st.replaced || null,
      changes: this.st.changes.slice(0, 5),
      seen: this.st.seen.slice(0, 5),
      daysLeft: b ? Math.max(0, Math.round((b.endsAt - now) / DAY)) : null,
    };
  }
}
