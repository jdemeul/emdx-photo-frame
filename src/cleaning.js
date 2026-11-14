// The display's daily panel cleaning: when it is, and the hands-off window the NAS keeps around
// it. Methods of FrameApp (see app.js).
import { log } from './log.js';
import { cleaningText } from './display.js';
import { changeClock } from './playlist.js';

export class Cleaning {
  // ---------- the daily panel cleaning ----------
  // The display cycles its panel through its colours once a day (the Samsung app's "screen
  // protection" time; it can be moved, not switched off). With the cleaning at night, an EM32DX
  // on battery often slept through the next morning's change (26 Oct to 8 Nov 2026), and once
  // hung halfway through it, the panel solid yellow (24 Oct). The NAS keeps its hands off the
  // display around the cleaning, as around a change. Its time comes from the display (read once
  // a day when the NAS talks to it anyway), else from CLEANING_TIME.
  // (A time the display gave earlier still counts when a later read fails: it is the display's
  // own setting, and a better guess than none.)
  cleaning() {
    const r = this.state.cleaning;
    if (r?.hour != null) return { hour: r.hour, minute: r.minute, source: 'display', readAt: r.goodAt ?? r.readAt };
    const c = this.cfg.display.cleaningTime;
    return c ? { ...c, source: 'setting' } : null;
  }

  // Read the cleaning time from the display at the next chance? Once a day; after a read that
  // failed, again within the hour.
  cleaningDue() {
    const r = this.state.cleaning;
    const every = r?.error ? 3600000 : 20 * 3600000;
    return !!this.cfg.display.host && (!r?.readAt || Date.now() - r.readAt > every);
  }

  noteCleaning(c) {
    if (!c) return;
    const prev = this.state.cleaning;
    const now = Date.now();
    if (c.error) {
      const known = prev?.hour != null ? { hour: prev.hour, minute: prev.minute, goodAt: prev.goodAt ?? prev.readAt } : {};
      this.state.cleaning = { ...known, error: c.error, readAt: now };
      const going = known.hour != null ? `; going by the time it gave before (${cleaningText(known)})` : this.cfg.display.cleaningTime ? '; going by CLEANING_TIME' : '';
      if (!prev?.error) log.info(`The display didn't say when it cleans its panel (${c.error})${going}.`);
    } else {
      this.state.cleaning = { ...c, readAt: now, goodAt: now };
      if (prev?.hour !== c.hour || prev?.minute !== c.minute) log.info(`The display cleans its panel daily at ${cleaningText(c)}; the NAS leaves it alone around then.`);
    }
    this.store.save();
  }

  cleaningClock() {
    const c = this.cleaning();
    if (!c) return null;
    const key = `${c.minute} ${c.hour}`;
    if (this._cleaningClock?.key !== key) this._cleaningClock = { key, clock: changeClock(`${c.minute} ${c.hour} * * *`, this.cfg.timezone) };
    return this._cleaningClock.clock;
  }

  // From update.cleaningQuietSec[0] before the cleaning until [1] after it starts.
  nearCleaning(now = Date.now()) {
    const clock = this.cleaningClock();
    if (!clock) return false;
    const [before, afterSec] = this.cfg.update.cleaningQuietSec;
    return clock.next(now) - now < before * 1000 || now - clock.prev(now) < afterSec * 1000;
  }

  // A cleaning within the next hour: no time to put a display in a light sleep into deep sleep.
  cleaningSoon(now = Date.now()) {
    const clock = this.cleaningClock();
    return !!clock && clock.next(now) - now < Math.max(3600, this.cfg.update.cleaningQuietSec[0]) * 1000;
  }

  // What the page shows: the time, where it came from, and the hands-off window.
  cleaningStatus() {
    const c = this.cleaning();
    const r = this.state.cleaning;
    if (!c) return r?.error ? { error: r.error, readAt: r.readAt } : null;
    const clock = this.cleaningClock();
    const [before, afterSec] = this.cfg.update.cleaningQuietSec;
    const next = clock.next(Date.now());
    return { time: cleaningText(c), source: c.source, readAt: c.source === 'display' ? c.readAt : r?.readAt ?? null, next, quietFrom: next - before * 1000, quietUntil: next + afterSec * 1000, ...(r?.error ? { error: r.error } : {}) };
  }
}
