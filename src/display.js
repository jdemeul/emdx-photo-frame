// Talking to the Samsung EMDX over Samsung MDC (TCP 1515, TLS + PIN), using
// @weejewel/samsung-mdc. The update trick is the one from
// github.com/WeeJeWel/node-samsung-emdx: tell the display (MDC command 0xC7) to
// download a small JSON "schedule" from our HTTP server, which points at the image.
//
// Sleep uses two more MDC commands that the EM32DX accepts (see the command notes in
// github.com/taylorRichie/node-samsung-emdx): 0x11 power (0x00 = off) and 0xB5 network
// standby, the Wi-Fi listener that Wake-on-LAN needs. With network standby off (deep
// sleep), nothing on the network wakes the display: Wake-on-LAN reached it half a minute
// into deep sleep but not seven hours later, and on battery even network standby stops
// hearing it after many hours. The display does wake itself once a day for its "screen
// protection time" (set in the Samsung E-Paper app). The EM32DX refuses 0x25, which those
// notes list as an on-timer; "Check display" also reads Samsung's standard MDC clock
// (0xA7) and timer 1 (0xA4), to see whether those are a way to set a wake-up time.
import dgram from 'node:dgram';
import { Device } from '@weejewel/samsung-mdc';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CMD_POWER = 0x11;
const CMD_NETWORK_STANDBY = 0xb5;
const CMD_TIMER1 = 0xa4;
const CMD_CLOCK = 0xa7;

const hex = (bytes) => Array.from(bytes || []).map((x) => x.toString(16).padStart(2, '0')).join(' ');

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

// Send one MDC command; a refusal (NAK) says which command and why.
async function cmd(device, commandId, data, what) {
  try {
    return await withTimeout(device.sendCommand({ commandId, data }), 8000, what);
  } catch (err) {
    if (err.message !== 'NAK') throw err;
    const code = err.payload?.length ? `, error code ${hex(err.payload)}` : '';
    throw new Error(`${what}: the display refused MDC command 0x${commandId.toString(16).padStart(2, '0')} (NAK${code})`);
  }
}

// Wake-on-LAN magic packet (6 x 0xFF, then the MAC 16 times). Sent with the broadcast
// flag always on, so a subnet broadcast address (e.g. 192.168.1.255) works too.
export async function sendWakeOnLan(cfg) {
  const d = cfg.display;
  if (!d.mac) throw new Error('EMDX_MAC is not set');
  const mac = Buffer.from(d.mac.replace(/[^0-9a-f]/gi, ''), 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(packet, d.wolPort, d.wolBroadcast, (err) => (err ? reject(err) : resolve()));
      });
    });
  } finally {
    socket.close();
  }
}

// Connect, sending Wake-on-LAN first when a MAC is known (unless `wol` is false). By
// default this makes CONNECT_ATTEMPTS tries; with `windowSec` it keeps trying until that
// much time has passed. `quiet`: progress at debug level (the caller reports the outcome).
// The device gets `waitedSec`: how long it took to answer, when it needed more than one try.
async function connect(cfg, { windowSec = 0, quiet = false, wol = true } = {}) {
  const d = cfg.display;
  if (!d.host) throw new Error('EMDX_HOST is not set');
  const start = Date.now();
  const deadline = windowSec ? start + windowSec * 1000 : 0;
  let lastErr;
  for (let attempt = 1; ; attempt++) {
    const device = new Device({ host: d.host, port: d.port, pin: d.pin });
    if (wol && d.mac) {
      try {
        await sendWakeOnLan(cfg);
      } catch (err) {
        log.warn(`Wake-on-LAN packet failed: ${err.message}`);
      }
      await sleep(d.wakeWaitSec * 1000);
    }
    try {
      await withTimeout(device.connect(), 15000, 'Connecting to the display');
      guard(device);
      if (attempt > 1) {
        device.waitedSec = Math.round((Date.now() - start) / 1000);
        log.info(`Display answered on attempt ${attempt}, after ${device.waitedSec} s`);
      }
      return device;
    } catch (err) {
      lastErr = err;
      destroy(device);
      if (/PIN|Blocked/i.test(err.message)) {
        throw new Error(`${err.message}. Check EMDX_PIN (the display's MDC PIN).`);
      }
      const more = deadline ? Date.now() + 5000 < deadline : attempt < d.connectAttempts;
      if (!more) break;
      log[quiet ? 'debug' : 'warn'](`Display not reachable yet (attempt ${attempt}${deadline ? '' : `/${d.connectAttempts}`}): ${err.message}`);
      await sleep(5000);
    }
  }
  const what = `Could not connect to the display at ${d.host}:${d.port} (${lastErr?.message})`;
  const e = new Error(`${what}. Is it on the network and is MDC enabled?`);
  e.unreachable = true;
  e.what = what; // without the hint, for callers that know better
  throw e;
}

// Switch network standby (the Wi-Fi listener Wake-on-LAN needs) on or off, if it isn't
// already. Returns what it was: true, false, or null when it couldn't be read.
async function setNetworkStandby(device, on) {
  let was = null;
  try {
    was = (await cmd(device, CMD_NETWORK_STANDBY, [], 'Reading network standby'))[0] === 0x01;
  } catch (err) {
    log.debug(err.message);
  }
  if (was !== on) {
    await sleep(300); // the display drops responses if commands come too fast
    await cmd(device, CMD_NETWORK_STANDBY, [on ? 0x01 : 0x00], `Turning network standby ${on ? 'on' : 'off'}`);
    log.info(was === null ? `Switched network standby ${on ? 'on' : 'off'}.`
      : `Network standby was ${was ? 'on' : 'off'}; switched it ${on ? 'on' : 'off'}.`);
  }
  return was;
}

// Push an image. `networkStandby` true/false switches network standby on/off during the
// update (null leaves it alone): the display may go to sleep by itself before the NAS
// sends it to sleep, and then sleeps the way it is set. `connect`: options for finding
// the display (see connect()). Returns { battery, waitedSec }; throws when the display
// never fetched the image.
export async function pushToDisplay(cfg, server, png, { networkStandby = null, connect: connectOpts = {} } = {}) {
  const d = cfg.display;
  const push = server.registerPush(png, 'png');
  let battery = null;
  let waitedSec = null;
  try {
    for (let attempt = 1; attempt <= d.pushAttempts; attempt++) {
      const device = await connect(cfg, attempt === 1 ? connectOpts : {});
      if (attempt === 1) waitedSec = device.waitedSec ?? null;
      try {
        try {
          battery = await withTimeout(device.getBatteryState(), 6000, 'Reading battery');
        } catch (err) {
          log.debug(`No battery info: ${err.message}`);
        }
        if (networkStandby !== null) {
          await sleep(300);
          try {
            await setNetworkStandby(device, networkStandby);
          } catch (err) {
            log.warn(`Could not switch network standby ${networkStandby ? 'on' : 'off'}: ${err.message}`);
          }
          await sleep(300);
        }
        log.info(`Asking the display to download ${push.contentUrl}`);
        await withTimeout(device.setContentDownload({ url: push.contentUrl }), 15000, 'Sending the content URL');
      } finally {
        await close(device);
      }
      const ok = await push.waitForImage(d.fetchTimeoutSec * 1000);
      if (ok) {
        log.info('The display downloaded the image; it will refresh in a moment.');
        return { battery, waitedSec };
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

// Put the display to sleep, then power it off. With `networkStandby` (standby), network
// standby is switched on first so that Wake-on-LAN can wake it; if that fails, the
// display stays awake rather than risk being powered off out of reach. Without it
// (deep sleep), network standby is switched off. Returns { battery }.
export async function putToSleep(cfg, { networkStandby = true } = {}) {
  const device = await connect(cfg, { windowSec: cfg.display.sleepWindowSec ?? 60, quiet: true });
  let battery = null;
  try {
    try {
      battery = await withTimeout(device.getBatteryState(), 6000, 'Reading battery');
    } catch (err) {
      log.debug(`No battery info: ${err.message}`);
    }
    await sleep(300);
    if (networkStandby) {
      await setNetworkStandby(device, true);
    } else {
      try {
        await setNetworkStandby(device, false);
      } catch (err) {
        log.warn(`Could not switch network standby off: ${err.message}`);
      }
    }
    await sleep(300);
    try {
      await cmd(device, CMD_POWER, [0x00], 'Powering off');
    } catch (err) {
      // A unit that powers down before answering is fine too.
      log.debug(`No acknowledgement for power-off: ${err.message}`);
    }
  } finally {
    await close(device);
  }
  return { battery };
}

// After a sleep command: did it really go to sleep? Probe without Wake-on-LAN (which
// would wake it) until it stops answering. Returns the seconds that took, or null if
// it still answers after `timeoutSec`.
export async function confirmAsleep(cfg, { timeoutSec = 150, everySec = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    await sleep(everySec * 1000);
    if (!(await probeDisplay(cfg))) return Math.round((Date.now() - start) / 1000);
  }
  return null;
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

// MDC clock (0xA7): day, hour (1-12), minute, month, year (2 bytes), AM (1) / PM (0).
export function formatClock(b) {
  const raw = `[${hex(b)}]`;
  if (!b || b.length < 7) return `unexpected answer ${raw}`;
  const [day, h12, min, month, y1, y2, am] = b;
  if (h12 === 0xff || min === 0xff) return 'not set';
  if (h12 < 1 || h12 > 12 || min > 59 || am > 1) return `unexpected answer ${raw}`;
  const p = (n) => String(n).padStart(2, '0');
  return `${(y1 << 8) | y2}-${p(month)}-${p(day)} ${p((h12 % 12) + (am ? 0 : 12))}:${p(min)}`;
}

// MDC timer 1 (0xA4): on time (hour 1-12, minute, AM/PM, active), off time (same), then
// repeat, weekdays, (15-byte version: off repeat, off weekdays), volume, source, holidays.
export function formatTimer(b) {
  const raw = `[${hex(b)}]`;
  if (!b || (b.length !== 13 && b.length !== 15)) return `unexpected answer ${raw}`;
  const p = (n) => String(n).padStart(2, '0');
  const time = (h, m, am) => (h === 0xff || m === 0xff ? 'not set' : `${p((h % 12) + (am ? 0 : 12))}:${p(m)}`);
  const repeat = ['once', 'every day', 'Mon-Fri', 'Mon-Sat', 'Sat-Sun', 'chosen days'][b[8]] ?? `repeat ${b[8]}`;
  const on = b[3] ? `on at ${time(b[0], b[1], b[2])} ${repeat}` : 'no on time';
  const off = b[7] ? `off at ${time(b[4], b[5], b[6])}` : 'no off time';
  return `${on}, ${off} ${raw}`;
}

export async function readDisplayInfo(cfg) {
  const device = await connect(cfg);
  try {
    const info = {};
    for (const [key, fn] of [
      ['name', () => device.getDeviceName()],
      ['serial', () => device.getSerialNumber()],
      ['software', () => device.getSoftwareVersion()],
      ['battery', () => device.getBatteryState()],
      ['networkStandby', async () => ((await device.sendCommand({ commandId: CMD_NETWORK_STANDBY }))[0] === 0x01 ? 'on' : 'off')],
      // Read only: a possible way to set a wake-up time (see the notes at the top).
      ['clock', async () => formatClock(await cmd(device, CMD_CLOCK, [], 'Reading the clock'))],
      ['onTimer', async () => formatTimer(await cmd(device, CMD_TIMER1, [], 'Reading timer 1'))],
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
