// Sleep: putting the display to sleep after an update and making sure it did, "Deep sleep now",
// and getting a display out of a light sleep (asleep but still on the Wi-Fi). Methods of FrameApp
// (see app.js); what the EM32DX does when: docs/findings.md.
import { log } from './log.js';
import { putToSleep, confirmAsleep, lookForDisplay, deepSleepNow } from './display.js';

export class Sleep {
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

  // "Deep sleep now" (/api/deep-sleep): what Samsung's app does for deep sleep (deepSleepNow() in
  // display.js), then watch the display: it should stop answering within a minute or so, and
  // then drop off the Wi-Fi. state.deepSleep says how far it got, for the page. `why`: who asked
  // (the button, or the NAS for a display in a light sleep); `unlessCharging`: leave a display on
  // the charger alone. Returns the record (its `step`: how it ended).
  async deepSleep({ why = 'button', unlessCharging = false } = {}) {
    const cfg = this.cfg;
    const rec = { at: Date.now(), why, step: 'sending' };
    const note = (fields) => { Object.assign(rec, fields); this.store.save(); };
    let done = false;
    await this.exclusive('Deep sleep now', async () => {
      this.state.deepSleep = rec; // (not before: a busy refusal would leave "sending" on the page)
      this.cancelSleep();
      try {
        const { battery, sleepAfter, charging } = await deepSleepNow(cfg, { unlessCharging });
        this.noteBattery(battery);
        this.markAwake();
        if (charging) {
          note({ step: 'charging' });
          done = true;
          return;
        }
        note({ step: 'sent', sleepAfter });
      } catch (err) {
        if (!err.unreachable) {
          note({ step: 'failed', error: err.message });
          throw err;
        }
        // No answer, not even to Wake-on-LAN: maybe it is in deep sleep already.
        note({ step: 'not reached' });
        done = true;
        return;
      }
      const after = await confirmAsleep(cfg, { timeoutSec: cfg.sleep.confirmSec, everySec: cfg.sleep.confirmEverySec });
      if (after === null) {
        note({ step: 'still awake' });
        throw new Error(`The display took the deep sleep command but still answered ${cfg.sleep.confirmSec} s later.`);
      }
      this.state.sleep = { mode: cfg.sleep.mode, asleep: true, sleptAt: Date.now(), confirmedAfter: after };
      note({ step: 'asleep', asleepAfter: after });
    });
    if (done) return rec;
    const end = await this.watchWifi({ untilAsleep: false, onCheck: (network) => note({ checkedAt: Date.now(), network }) });
    note({ step: end.result, ...(end.result === 'off the Wi-Fi' ? { offAfter: Math.round((end.at - rec.at) / 1000) } : {}),
      ...(end.result === 'awake again' ? { awakeAfter: Math.round((end.at - rec.at) / 1000) } : {}) });
    if (end.result === 'off the Wi-Fi') log.info(`Deep sleep: the display is off the Wi-Fi, ${rec.offAfter} s after the command.`);
    if (end.result === 'still on the Wi-Fi') log.warn('Deep sleep: the display is asleep but still on the Wi-Fi (a light sleep).');
    return rec;
  }

  // Is the display off the Wi-Fi yet? One short knock now and then (sleep.offWifiChecksSec
  // apart). `untilAsleep`: it may still be awake at first (after an update it goes to sleep by
  // itself); otherwise answering means it woke up again. Returns { result, at }: 'off the Wi-Fi',
  // 'still on the Wi-Fi', 'awake again', 'still awake' or 'asleep (Wi-Fi unknown)'.
  async watchWifi({ untilAsleep, onCheck = () => {} }) {
    let network = null;
    let awake = false;
    for (const sec of this.cfg.sleep.offWifiChecksSec) {
      await new Promise((r) => setTimeout(r, sec * 1000));
      let found = null;
      try {
        found = await this.exclusive('Is the display off the Wi-Fi?', () => this.look());
      } catch { continue; } // (busy)
      awake = found.awake;
      if (awake) {
        this.markAwake();
        if (!untilAsleep) return { result: 'awake again', at: Date.now() };
        continue;
      }
      const z = this.state.sleep;
      if (z && !z.asleep && z.mode === this.cfg.sleep.mode) this.state.sleep = { mode: z.mode, asleep: true, sleptAt: Date.now(), self: true };
      network = found.network ?? network;
      if (this.state.sleep?.asleep && found.network) this.state.sleep.network = found.network;
      onCheck(network);
      if (network === 'off') return { result: 'off the Wi-Fi', at: Date.now() };
    }
    const result = awake ? 'still awake' : network === 'on' ? 'still on the Wi-Fi' : 'asleep (Wi-Fi unknown)';
    return { result, at: Date.now() };
  }

  // A probe (see lookForDisplay()).
  look(opts) {
    return lookForDisplay(this.cfg, opts);
  }

  // ---------- light sleep ----------
  // With SLEEP_MODE=deep, a display that doesn't answer but is still on the Wi-Fi at
  // sleep.lightSleepChecks sleep checks in a row is in a light sleep: an EM32DX stayed like that
  // for days, at about 1.5% battery an hour. Returns true when the NAS should step in.
  lightSleepSeen(network) {
    if (this.cfg.sleep.mode !== 'deep') return false;
    const st = this.state;
    let ls = st.lightSleep;
    const now = Date.now();
    if (network === 'off') {
      if (ls && !ls.endedAt && ls.strikes) {
        ls.endedAt = now;
        this.clearAlert('lightsleep', 'The display is off the Wi-Fi again: in deep sleep.');
        if (ls.tries.length) log.info('The display is off the Wi-Fi again: in deep sleep.');
      }
      return false;
    }
    if (network !== 'on') return false;
    if (!ls || ls.endedAt || (ls.gaveUp && now - ls.gaveUp > 20 * 3600000) || (ls.charging && now - ls.charging > 6 * 3600000)) {
      ls = st.lightSleep = { since: now, strikes: 0, tries: [] };
    }
    ls.strikes++;
    ls.lastSeen = now;
    return ls.strikes >= this.cfg.sleep.lightSleepChecks && !ls.gaveUp && !ls.charging;
  }

  // Put a display in a light sleep into deep sleep: wake it (Wake-on-LAN reaches it then) and send
  // what the Samsung app sends for deep sleep; if it is still on the Wi-Fi after that, send it
  // the playlist (or the photo) again: after an update it has gone into deep sleep by itself. If
  // that doesn't help either, the page asks for a hand (a press on its power button, a restart).
  // A display on the charger is left alone.
  async fixLightSleep() {
    const ls = this.state.lightSleep;
    if (ls.tries.length >= 3) { // (e.g. Wake-on-LAN didn't reach it, again and again)
      ls.gaveUp = Date.now();
      this.store.save();
      return;
    }
    this.fixing = true;
    try {
      log.warn('Sleep check: the display has stayed on the Wi-Fi while asleep (a light sleep); putting it into deep sleep.');
      let first;
      try {
        first = await this.deepSleep({ why: 'light sleep', unlessCharging: true });
      } catch (err) {
        first = { at: Date.now(), step: `failed: ${err.message}` };
      }
      ls.tries.push({ at: first.at, how: 'deep sleep command', result: first.step });
      this.store.save();
      if (first.step === 'charging') {
        ls.charging = Date.now();
        log.info('The display is on the charger: leaving it alone.');
        return;
      }
      if (first.step === 'off the Wi-Fi' || first.step === 'not reached') {
        if (first.step === 'off the Wi-Fi') {
          ls.endedAt = Date.now();
          log.info('The display is off the Wi-Fi: in deep sleep.');
        }
        return;
      }
      const second = { at: Date.now(), how: this.daily ? 'playlist sent again' : 'photo sent again', result: 'sending' };
      ls.tries.push(second);
      this.store.save();
      try {
        if (this.daily) await this.run('Sending the playlist', () => this.daily.send('light sleep'));
        else await this.run('Sending again', () => this.push(this.state.current, { reason: 'light sleep' }));
      } catch (err) {
        second.result = `not sent: ${err.message}`;
        if (err.busy) { // (something else was talking to it: no reason to give up for the day)
          ls.tries.pop();
          return;
        }
      }
      if (second.result === 'sending') {
        const end = await this.watchWifi({ untilAsleep: true });
        second.result = end.result;
        if (end.result === 'off the Wi-Fi') {
          ls.endedAt = Date.now();
          log.info('The display is off the Wi-Fi after the update: in deep sleep.');
        }
      }
      if (!ls.endedAt) {
        ls.gaveUp = Date.now();
        log.warn('The display is still in a light sleep: press its power button and leave it alone; if it stays on the Wi-Fi, restart it.');
        this.alert('lightsleep', 'not in deep sleep', 'The display is asleep but stays on the Wi-Fi, which costs about 1.5% battery an hour. Press its power button and leave it alone; if it stays on the Wi-Fi, restart it.');
      }
    } finally {
      this.fixing = false;
      this.store.save();
    }
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
}
