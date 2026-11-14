// The periodic looks at the display: the sleep check (is it asleep, and off the Wi-Fi?) and, after
// a change it missed, the look for it every MISSED_CHECK_SEC. Methods of FrameApp (see app.js).
import { log } from './log.js';

export class Checks {
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

  // ---------- after a missed change ----------
  // Playlist mode: when the display didn't come online after a change (it slept through it, or
  // hung), look for it every MISSED_CHECK_SEC (no Wake-on-LAN, which doesn't reach it in deep
  // sleep anyway) until it is back, e.g. after a press on its power button, and send it a fresh
  // playlist then. These looks don't count towards a light sleep: right after a button press the
  // display can be on the Wi-Fi without answering for a while.
  startMissedWatch() {
    const sec = this.cfg.sleep.missedCheckSec;
    if (!sec || !this.daily || !this.cfg.display.host || this.missedTimer) return;
    this.missedTimer = setInterval(() => {
      this.checkMissed().catch((err) => log.warn(`Looking for the display: ${err.message}`));
    }, sec * 1000);
    this.missedTimer.unref?.(); // (the web server keeps the service running)
  }

  stopMissedWatch() {
    clearInterval(this.missedTimer);
    this.missedTimer = null;
  }

  async checkMissed() {
    const m = this.daily?.missedOpen();
    if (!m) { this.stopMissedWatch(); return null; }
    if (this.busy || this.fixing || this.sleepTimer || this.retryTimer || this.daily.nearChange() || this.nearCleaning()) return null;
    if (m.retryAt && Date.now() < m.retryAt) return null;
    const { awake, battery, cleaning } = await this.exclusive('Looking for the display (it missed a change)', () => this.look({ battery: true, cleaning: this.cleaningDue() }), { probe: true });
    if (!awake) return false;
    this.noteCleaning(cleaning);
    const event = this.noteWake({ afterMiss: true });
    this.noteBattery(battery);
    log.info(`The display is back after missing the change${battery?.batteryPercent != null ? ` (battery ${battery.batteryPercent}%)` : ''}.`);
    try {
      let sent = false;
      try {
        sent = await this.daily.onAwake('after a missed change');
      } catch (err) {
        event.error = err.message;
        m.retryAt = Date.now() + 5 * 60000; // (don't knock every minute on a display that takes the connection but not the playlist)
        log.warn(`Could not send the playlist: ${err.message}. Trying again in 5 minutes if it is still awake.`);
        return true;
      }
      if (sent) event.sent = 'playlist';
      else { this.daily.resolveMissed('nothing to send'); event.leftAlone = true; }
      this.stopMissedWatch();
      return true;
    } finally {
      this.finishWake(event);
    }
  }

  async checkAsleep() {
    if (this.busy || this.fixing || this.sleepTimer || this.retryTimer || this.daily?.nearChange() || this.nearCleaning()) return null;
    const own = this.state.sleep?.own && !this.state.sleep.asleep ? this.state.sleep : null;
    if (own && Date.now() - own.at < this.cfg.sleep.ownSleepSec * 1000) return null; // (give it time to go to sleep)
    const { awake, battery, network, cleaning } = await this.exclusive('Checking that the display is asleep', () => this.look({ battery: true, cleaning: this.cleaningDue() }), { probe: true });
    if (awake) this.noteCleaning(cleaning);
    const st = this.state;
    const prev = st.lastCheck;
    st.lastCheck = { at: Date.now(), awake, network: awake ? 'on' : network };
    if (!awake) {
      // Believed awake, but it doesn't answer: it went to sleep by itself. Either way, note
      // whether it is still on the Wi-Fi.
      const z = st.sleep;
      if (z && !z.asleep && z.mode === this.cfg.sleep.mode) st.sleep = { mode: z.mode, asleep: true, sleptAt: Date.now(), self: true };
      if (st.sleep?.asleep && network) st.sleep.network = network;
      // (Not when a change is due within the hour: the display wakes up for it anyway. Nor right
      // before its panel cleaning.)
      const act = this.lightSleepSeen(network) && !this.daily?.changeSoon() && !this.cleaningSoon();
      this.store.save();
      if (act) await this.fixLightSleep();
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
          // Leave it be: with SLEEP_MODE=standby the failed send already scheduled the sleep
          // (run() → afterFailure()); in playlist mode with deep sleep it goes to sleep by
          // itself, and a power-off command now would leave it in a light sleep (findings.md).
          return true;
        }
        if (sent) {
          event.sent = 'playlist'; // it goes back to sleep after the update, as always
          return true;
        }
        // (Awake at the previous check too, and not sent to sleep since.)
        const { checkMin } = this.cfg.sleep;
        const stillAwake = prev?.awake && !(st.sleep?.sleptAt > prev.at) && (!checkMin || event.at - prev.at <= 2 * checkMin * 60000);
        const charging = !!battery?.pluggedIn;
        if (!stillAwake || charging) {
          log.info(charging ? 'Sleep check: the display is awake and charging; leaving it alone.'
            : 'Sleep check: the display is awake and its playlist is up to date; it goes back to sleep by itself (if it is still awake at the next check, the NAS sends it to sleep).');
          event.leftAlone = true;
          return true;
        }
        log.info('Sleep check: the display is still awake and its playlist is up to date; putting it back to sleep.');
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
    // Awake is not a light sleep: strikes from before it don't count towards the next one (one
    // the NAS already tried to fix stays, with what it tried, for the page).
    const ls = this.state.lightSleep;
    if (ls && !ls.endedAt && !ls.tries?.length) this.state.lightSleep = null;
    this.store.save();
    return event;
  }

  finishWake(event) {
    const b = this.state.battery;
    if (b?.at >= event.at) Object.assign(event, { battery: b.batteryPercent ?? null, charging: !!b.pluggedIn });
    this.store.save();
  }
}
