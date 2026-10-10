// Talking to the Samsung EMDX over Samsung MDC (TCP 1515, TLS + PIN), using
// @weejewel/samsung-mdc. The update trick is the one from
// github.com/WeeJeWel/node-samsung-emdx: tell the display (MDC command 0xC7) to
// download a small JSON "schedule" from our HTTP server, which points at the image.
//
// Sleep/wake uses three more MDC commands that the EM32DX accepts, as mapped out by
// github.com/taylorRichie/node-samsung-emdx (docs/MDC-COMMANDS.md, lib/Device.mjs):
//   0x11 power (0x00 = off), 0xB5 network standby (Wi-Fi listener for Wake-on-LAN),
//   0x25 on-timer: [enabled, repeat, hour, minute, 0x01], repeat 0x01 once, 0x02 daily,
//   0x03 Mon-Fri. (Not the numbering of the timers on Samsung's other signage.)
import { Device } from '@weejewel/samsung-mdc';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CMD_POWER = 0x11;
const CMD_NETWORK_STANDBY = 0xb5;
const CMD_ON_TIMER = 0x25;
const CMD_CLOCK = 0xa7;
const REPEAT_DAILY = 0x02;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

function destroy(device) {
  for (const s of [device._connectionTLS, device._connectionTCP]) {
    try { s?.destroy(); } catch { /* ignore */ }
  }
}

function guard(device) {
  // The library listens for socket errors only once; keep late errors from crashing us.
  device._connectionTLS?.on('error', () => {});
  device._connectionTCP?.on('error', () => {});
}

async function close(device) {
  try { await withTimeout(device.disconnect(), 5000, 'Disconnecting'); } catch { /* ignore */ }
  destroy(device);
}

const cmd = (device, commandId, data, what) =>
  withTimeout(device.sendCommand({ commandId, data }), 8000, what);

// Connect, sending Wake-on-LAN first when a MAC is known. By default this makes
// CONNECT_ATTEMPTS tries; with `windowSec` it keeps trying until that much time
// has passed (used when a display is due to wake itself from deep sleep).
// `quiet`: progress at debug level (the caller reports the outcome).
async function connect(cfg, { windowSec = 0, wol = true, quiet = false } = {}) {
  const d = cfg.display;
  if (!d.host) throw new Error('EMDX_HOST is not set');
  const deadline = windowSec ? Date.now() + windowSec * 1000 : 0;
  let lastErr;
  for (let attempt = 1; ; attempt++) {
    const device = new Device({ host: d.host, port: d.port, pin: d.pin, ...(d.mac ? { mac: d.mac } : {}) });
    if (wol && d.mac) {
      try {
        await device.wakeup({ host: d.wolBroadcast });
      } catch (err) {
        log.warn(`Wake-on-LAN packet failed: ${err.message}`);
      }
      await sleep(d.wakeWaitSec * 1000);
    }
    try {
      await withTimeout(device.connect(), 15000, 'Connecting to the display');
      guard(device);
      if (attempt > 1) log.info(`Display answered on attempt ${attempt}`);
      return device;
    } catch (err) {
      lastErr = err;
      destroy(device);
      if (/PIN|Blocked/i.test(err.message)) {
        throw new Error(`${err.message}. Check EMDX_PIN (the display's MDC PIN).`);
      }
      const more = deadline ? Date.now() + 5000 < deadline : attempt < d.connectAttempts;
      if (!more) break;
      if (!deadline || attempt === 1 || attempt % 6 === 0) {
        log[quiet ? 'debug' : 'warn'](`Display not reachable yet (attempt ${attempt}${deadline ? '' : `/${d.connectAttempts}`}): ${err.message}`);
      }
      await sleep(5000);
    }
  }
  const what = `Could not connect to the display at ${d.host}:${d.port} (${lastErr?.message})`;
  const e = new Error(`${what}. Is it on the network and is MDC enabled?`);
  e.unreachable = true;
  e.what = what; // without the hint, for callers that know better
  throw e;
}

async function armWake(device, wake) {
  await cmd(device, CMD_ON_TIMER, [0x01, REPEAT_DAILY, wake.hour, wake.minute, 0x01], 'Setting the wake-up timer');
}

// Push an image. Options:
//   wake:      { hour, minute } — arm the display's daily wake-up timer in the same session
//   windowSec: keep trying to connect this long (display waking itself from deep sleep)
// Returns { battery, armed }; throws when the display never fetched the image.
export async function pushToDisplay(cfg, server, png, { wake = null, windowSec = 0 } = {}) {
  const d = cfg.display;
  const push = server.registerPush(png, 'png');
  let battery = null;
  let armed = false;
  try {
    for (let attempt = 1; attempt <= d.pushAttempts; attempt++) {
      const device = await connect(cfg, { windowSec: attempt === 1 ? windowSec : 0 });
      try {
        try {
          battery = await withTimeout(device.getBatteryState(), 6000, 'Reading battery');
        } catch (err) {
          log.debug(`No battery info: ${err.message}`);
        }
        if (wake) {
          // Arm it now: even if the display dozes off on its own before we send it
          // to sleep, it will still wake up for the next update.
          try {
            await armWake(device, wake);
            armed = true;
          } catch (err) {
            log.warn(`Could not set the wake-up timer: ${err.message}`);
          }
        }
        log.info(`Asking the display to download ${push.contentUrl}`);
        await withTimeout(device.setContentDownload({ url: push.contentUrl }), 15000, 'Sending the content URL');
      } finally {
        await close(device);
      }
      const ok = await push.waitForImage(d.fetchTimeoutSec * 1000);
      if (ok) {
        log.info('The display downloaded the image; it will refresh in a moment.');
        return { battery, armed };
      }
      log.warn(`The display did not fetch the image within ${d.fetchTimeoutSec}s (attempt ${attempt}/${d.pushAttempts}).`);
    }
  } finally {
    push.done();
  }
  throw new Error(
    `The display accepted the command but never downloaded ${push.imageUrl}. ` +
      'Check that it can reach this NAS on that address (SERVER_HOST, HTTP_PORT, NAS firewall).',
  );
}

// Put the display to sleep.
//   deep:    (re)arm the daily wake-up timer, Wi-Fi listener off, power off
//   standby: Wi-Fi listener on (reachable by Wake-on-LAN), power off
export async function putToSleep(cfg, { mode, wake = null }) {
  const device = await connect(cfg, { windowSec: 60, quiet: true });
  try {
    if (mode === 'deep') {
      if (!wake) throw new Error('Deep sleep needs a wake-up time');
      await armWake(device, wake);
      await cmd(device, CMD_NETWORK_STANDBY, [0x00], 'Turning off network standby');
    } else {
      // Wake-on-LAN does the waking in this mode; switch off any timer left from deep sleep.
      try {
        await cmd(device, CMD_ON_TIMER, [0x00, REPEAT_DAILY, 0, 0, 0x01], 'Clearing the wake-up timer');
      } catch (err) {
        log.debug(`Could not clear the wake-up timer: ${err.message}`);
      }
      await cmd(device, CMD_NETWORK_STANDBY, [0x01], 'Turning on network standby');
    }
    try {
      await cmd(device, CMD_POWER, [0x00], 'Powering off');
    } catch (err) {
      // A unit that powers down before answering is fine too.
      log.debug(`No acknowledgement for power-off: ${err.message}`);
    }
  } finally {
    await close(device);
  }
}

// One quick connection attempt without Wake-on-LAN: is the display awake right now?
export async function probeDisplay(cfg) {
  const d = cfg.display;
  const device = new Device({ host: d.host, port: d.port, pin: d.pin });
  try {
    await withTimeout(device.connect(), 6000, 'Probe');
    guard(device);
    return true;
  } catch {
    return false;
  } finally {
    await close(device);
  }
}

export async function readDisplayInfo(cfg) {
  const device = await connect(cfg);
  try {
    const info = {};
    const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
    for (const [key, fn] of [
      ['name', () => device.getDeviceName()],
      ['serial', () => device.getSerialNumber()],
      ['software', () => device.getSoftwareVersion()],
      ['battery', () => device.getBatteryState()],
      ['networkStandby', async () => ((await device.sendCommand({ commandId: CMD_NETWORK_STANDBY }))[0] === 0x01 ? 'on' : 'off')],
      ['onTimer', async () => {
        const r = await device.sendCommand({ commandId: CMD_ON_TIMER });
        return r[0] === 0x01 && r.length >= 4
          ? `on, ${String(r[2]).padStart(2, '0')}:${String(r[3]).padStart(2, '0')} (repeat ${r[1]}) [${hex(r)}]`
          : `off [${hex(r)}]`;
      }],
      ['clockRaw', async () => hex(await device.sendCommand({ commandId: CMD_CLOCK }))],
    ]) {
      try {
        info[key] = await withTimeout(fn(), 6000, key);
      } catch (err) {
        info[key] = `(${err.message})`;
      }
      await sleep(300); // the display drops responses if commands come too fast
    }
    return info;
  } finally {
    await close(device);
  }
}
