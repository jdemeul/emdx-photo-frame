// Talking to the Samsung EMDX over Samsung MDC (TCP 1515, TLS + PIN), using
// @weejewel/samsung-mdc. The update trick is the one from
// github.com/WeeJeWel/node-samsung-emdx: tell the display (MDC command 0xC7) to
// download a small JSON "schedule" from our HTTP server, which points at the image.
//
// Sleep uses two more MDC commands that the EM32DX accepts (see the command notes in
// github.com/taylorRichie/node-samsung-emdx): 0x11 power (0x00 = off) and 0xB5 network
// standby, the Wi-Fi listener that Wake-on-LAN needs. Deep sleep (network standby off)
// is not used: there is no known way to make the display wake itself on a timer (the
// EM32DX refuses 0x25, which those notes list as an on-timer; on Samsung's other screens
// 0x25 is brightness), and Wake-on-LAN reached it half a minute into deep sleep but
// not seven hours later.
import dgram from 'node:dgram';
import { Device } from '@weejewel/samsung-mdc';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CMD_POWER = 0x11;
const CMD_NETWORK_STANDBY = 0xb5;

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

// Connect, sending Wake-on-LAN first when a MAC is known. By default this makes
// CONNECT_ATTEMPTS tries; with `windowSec` it keeps trying until that much time has passed.
// `quiet`: progress at debug level (the caller reports the outcome).
async function connect(cfg, { windowSec = 0, quiet = false } = {}) {
  const d = cfg.display;
  if (!d.host) throw new Error('EMDX_HOST is not set');
  const deadline = windowSec ? Date.now() + windowSec * 1000 : 0;
  let lastErr;
  for (let attempt = 1; ; attempt++) {
    const device = new Device({ host: d.host, port: d.port, pin: d.pin });
    if (d.mac) {
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

// Make sure network standby (the Wi-Fi listener Wake-on-LAN needs) is on.
// Returns whether it already was: true, false, or null when it couldn't be read.
async function ensureNetworkStandby(device) {
  let was = null;
  try {
    was = (await cmd(device, CMD_NETWORK_STANDBY, [], 'Reading network standby'))[0] === 0x01;
  } catch (err) {
    log.debug(err.message);
  }
  if (was !== true) {
    await sleep(300); // the display drops responses if commands come too fast
    await cmd(device, CMD_NETWORK_STANDBY, [0x01], 'Turning on network standby');
    log.info(was === false ? 'Network standby was off; switched it on.' : 'Switched network standby on.');
  }
  return was;
}

// Push an image. With `networkStandby`, also make sure network standby is on: the
// display may go to sleep by itself before the NAS sends it to sleep, and it then
// needs network standby for Wake-on-LAN to wake it next time.
// Returns { battery }; throws when the display never fetched the image.
export async function pushToDisplay(cfg, server, png, { networkStandby = false } = {}) {
  const d = cfg.display;
  const push = server.registerPush(png, 'png');
  let battery = null;
  try {
    for (let attempt = 1; attempt <= d.pushAttempts; attempt++) {
      const device = await connect(cfg);
      try {
        try {
          battery = await withTimeout(device.getBatteryState(), 6000, 'Reading battery');
        } catch (err) {
          log.debug(`No battery info: ${err.message}`);
        }
        if (networkStandby) {
          await sleep(300);
          try {
            await ensureNetworkStandby(device);
          } catch (err) {
            log.warn(`Could not switch network standby on: ${err.message}`);
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
        return { battery };
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

// Put the display to sleep: make sure network standby is on, so Wake-on-LAN can wake
// it, then power off. If network standby can't be switched on, the display stays
// awake rather than risk being powered off out of reach.
export async function putToSleep(cfg) {
  const device = await connect(cfg, { windowSec: cfg.display.sleepWindowSec ?? 60, quiet: true });
  try {
    await ensureNetworkStandby(device);
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
    for (const [key, fn] of [
      ['name', () => device.getDeviceName()],
      ['serial', () => device.getSerialNumber()],
      ['software', () => device.getSoftwareVersion()],
      ['battery', () => device.getBatteryState()],
      ['networkStandby', async () => ((await device.sendCommand({ commandId: CMD_NETWORK_STANDBY }))[0] === 0x01 ? 'on' : 'off')],
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
