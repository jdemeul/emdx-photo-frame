// Talking to the Samsung EMDX over Samsung MDC (TCP 1515, TLS + PIN), with
// @weejewel/samsung-mdc. Content goes the way Samsung's E-Paper app sends it (and
// github.com/WeeJeWel/node-samsung-emdx): MDC 0xC7 points the display at a JSON manifest on our
// HTTP server, and the display downloads it and the images in it. Sleep uses 0x11 (power off)
// and 0xB5 (network standby, the Wi-Fi listener that Wake-on-LAN needs). The other commands here
// come from Samsung's Android app (decompiled): 0xC7/0x53 type 0x01 "apply sleep mode after
// content update", 0xC7/0x54 a thumbnail of the screen, 0xC6/0x81 "Sleep After", 0xCB optional
// features. What the EM32DX does with them: docs/findings.md.
import dgram from 'node:dgram';
import { Device } from '@weejewel/samsung-mdc';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CMD_POWER = 0x11;
const CMD_NETWORK_STANDBY = 0xb5;
const CMD_CONTENT = 0xc7; // sub 0x53: content download (type 0x80) / apply sleep after update (type 0x01); 0x54: thumbnail
const CMD_SLEEP_AFTER = 0xc6; // sub 0x81
const CMD_FEATURES = 0xcb;

// "Sleep After" codes, as the Samsung app sets them (0xF0 = custom, followed by 2 bytes).
const SLEEP_AFTER_TEXT = { 0x00: 'off', 0x06: '5 min', 0x07: '10 min', 0x08: '20 min', 0x09: '30 min', 0x0a: '60 min' };

const hex = (bytes) => Array.from(bytes || []).map((x) => x.toString(16).padStart(2, '0')).join(' ');

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`), { timedOut: true })), ms);
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

// Wake-on-LAN magic packet (6 x 0xFF, then the MAC 16 times). Sent with the broadcast flag
// always on, so a subnet broadcast address (e.g. 192.168.1.255) works too.
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

// Connect, sending Wake-on-LAN first when a MAC is known (unless `wol` is false). By default
// this makes CONNECT_ATTEMPTS tries; with `windowSec` it keeps trying until that much time has
// passed. `quiet`: progress at debug level (the caller reports the outcome). The device gets
// `waitedSec`: how long it took to answer, when it needed more than one try.
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

// Connect (options as for connect()), run fn(device), disconnect.
export async function withDisplay(cfg, opts, fn) {
  const device = await connect(cfg, opts);
  try {
    return await fn(device);
  } finally {
    await close(device);
  }
}

// One quick connection attempt without Wake-on-LAN: is the display awake right now?
export async function probeDisplay(cfg) {
  return (await lookForDisplay(cfg)).awake;
}

// The same, and with `battery`, read the battery while connected. Returns { awake, battery,
// network }: for a display that doesn't answer, whether it is still on the network (see
// networkState()).
export async function lookForDisplay(cfg, { battery: readBattery = false } = {}) {
  const d = cfg.display;
  const device = new Device({ host: d.host, port: d.port, pin: d.pin });
  try {
    try {
      await withTimeout(device.connect(), 6000, 'Probe');
      guard(device);
    } catch (err) {
      return { awake: false, battery: null, network: networkState(err) };
    }
    let battery = null;
    if (readBattery) {
      try {
        battery = await withTimeout(device.getBatteryState(), 6000, 'Reading battery');
      } catch (err) {
        log.debug(`No battery info: ${err.message}`);
      }
    }
    return { awake: true, battery };
  } finally {
    await close(device);
  }
}

// Why a connection failed tells whether a sleeping display is still on the network: no answer
// at all (EHOSTUNREACH: nothing answers its address) means its Wi-Fi is off, as in deep sleep;
// an attempt that times out or is refused means it is still on the Wi-Fi, only asleep (on an
// EM32DX that costs about 1.5% battery an hour). Returns 'off', 'on' or null (can't tell).
export function networkState(err) {
  const code = err?.code ?? err?.cause?.code;
  if (['EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH'].includes(code)) return 'off';
  if (err?.timedOut || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return 'on';
  return null;
}

// Switch network standby on or off, if it isn't already. Returns what it was: true, false, or
// null when it couldn't be read.
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

// Push one image (a PNG for the display).
export function pushToDisplay(cfg, server, png, opts = {}) {
  return pushContent(cfg, server, { items: [{ buf: png, ext: 'png' }] }, opts);
}

// Push content: one image, or a playlist ({ items: [{ buf or file, durationMs }], contentType:
// 'PlaylistContent' }), which the display downloads in full and then plays by itself.
// `networkStandby` true/false switches network standby on/off during the update (null leaves
// it alone): the display may go to sleep by itself before the NAS sends it to sleep, and then
// sleeps the way it is set. `connect`: options for finding the display (see connect()).
// Waits until the display has fetched every image. Returns { battery, waitedSec, content }
// (`content`: what the NAS served, to serve it again after a restart).
export async function pushContent(cfg, server, content, { networkStandby = null, connect: connectOpts = {} } = {}) {
  const d = cfg.display;
  const push = server.registerContent(content);
  const what = push.count === 1 ? 'the image' : `all ${push.count} images`;
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
      // Waits until every image is fetched, or until no new one came for FETCH_TIMEOUT_SEC.
      const got = await push.waitForImages(d.fetchTimeoutSec * 1000);
      if (got === push.count) {
        log.info(`The display downloaded ${what}; it will refresh in a moment.`);
        return { battery, waitedSec, content: push.saved() };
      }
      if (got > 0) {
        throw new Error(`The display downloaded ${got} of ${push.count} images, then stopped (nothing for ${d.fetchTimeoutSec}s).`);
      }
      log.warn(`The display did not fetch ${what} within ${d.fetchTimeoutSec}s (attempt ${attempt}/${d.pushAttempts}).`);
    }
  } finally {
    push.done();
  }
  throw new Error(
    `The display accepted the command but never downloaded ${push.imageUrl}. `
      + 'Check that it can reach this NAS on that address (SERVER_HOST, HTTP_PORT, NAS firewall).',
  );
}

// Put the display to sleep: network standby on (standby, so that Wake-on-LAN can wake it; if
// that fails it stays awake rather than risk being powered off out of reach) or off (deep
// sleep), then power off. Returns { battery }.
export async function putToSleep(cfg, { networkStandby = true } = {}) {
  const device = await connect(cfg, { windowSec: cfg.display.sleepWindowSec, quiet: true });
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

// After a sleep command: did it really go to sleep? Probe without Wake-on-LAN (which would
// wake it) until it stops answering. Returns the seconds that took, or null if it still
// answers after `timeoutSec`.
export async function confirmAsleep(cfg, { timeoutSec = 150, everySec = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    await sleep(everySec * 1000);
    if (!(await probeDisplay(cfg))) return Math.round((Date.now() - start) / 1000);
  }
  return null;
}

// Answers to sub-commands start with the sub-command itself; drop it.
const stripSub = (sub, r) => [...(r?.[0] === sub ? r.subarray(1) : r || [])];

// "Sleep After" (0xC6/0x81), the display's own inactivity timer, as text.
export function formatSleepAfter(bytes) {
  if (!bytes?.length) return 'unknown';
  if (bytes[0] === 0xf0 && bytes.length >= 3) return `custom (${(bytes[1] << 8) | bytes[2]})`;
  return SLEEP_AFTER_TEXT[bytes[0]] ?? `code ${bytes[0]}`;
}

// Ask the display to POST a thumbnail of what it shows to `url` (0xC7/0x54 + URL).
export async function requestThumbnail(device, url) {
  if (url.length > 250) throw new Error('Thumbnail URL is too long for MDC');
  await cmd(device, CMD_CONTENT, [0x54, ...Buffer.from(url)], 'Asking for a thumbnail');
}

// "Check display": name, firmware, battery and settings. `thumbnailUrl`: also ask the display
// to POST a thumbnail of its screen there.
export async function readDisplayInfo(cfg, { thumbnailUrl = null } = {}) {
  const device = await connect(cfg);
  try {
    const info = {};
    const onOff = (v) => (v ? 'on' : 'off');
    for (const [key, fn] of [
      ['name', () => device.getDeviceName()],
      ['serial', () => device.getSerialNumber()],
      ['software', () => device.getSoftwareVersion()],
      ['battery', () => device.getBatteryState()],
      ['networkStandby', async () => onOff((await cmd(device, CMD_NETWORK_STANDBY, [], 'Reading network standby'))[0] === 0x01)],
      ['sleepAfter', async () => formatSleepAfter(stripSub(0x81, await cmd(device, CMD_SLEEP_AFTER, [0x81], 'Reading Sleep After')))],
      ['applySleep', async () => {
        const d = stripSub(0x53, await cmd(device, CMD_CONTENT, [0x53], 'Reading "apply sleep mode after content update"'));
        return d.length >= 2 && d[0] === 0x01 ? onOff(d[1] === 0x01) : `unknown [${hex(d)}]`;
      }],
      // Bit 0 of the second byte: a low-power (2.4 GHz) Wi-Fi module for remote wake-up (EMDX-A).
      ['lowPowerWifi', async () => { const r = await cmd(device, CMD_FEATURES, [], 'Reading features'); return r.length > 1 ? ((r[1] & 1) ? 'yes' : 'no') : `unknown [${hex(r)}]`; }],
      ...(thumbnailUrl ? [['thumbnail', async () => { await requestThumbnail(device, thumbnailUrl); return 'asked'; }]] : []),
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
