// Talking to the Samsung EMDX over Samsung MDC (TCP 1515, TLS + PIN), using
// @weejewel/samsung-mdc. The update trick is the one from
// github.com/WeeJeWel/node-samsung-emdx: tell the display (MDC command 0xC7) to
// download a small JSON "schedule" from our HTTP server, which points at the image.
import { Device } from '@weejewel/samsung-mdc';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function connect(cfg) {
  const d = cfg.display;
  if (!d.host) throw new Error('EMDX_HOST is not set');
  let lastErr;
  for (let attempt = 1; attempt <= d.connectAttempts; attempt++) {
    const device = new Device({ host: d.host, port: d.port, pin: d.pin, ...(d.mac ? { mac: d.mac } : {}) });
    if (d.mac) {
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
      return device;
    } catch (err) {
      lastErr = err;
      destroy(device);
      if (/PIN|Blocked/i.test(err.message)) {
        throw new Error(`${err.message}. Check EMDX_PIN (the display's MDC PIN).`);
      }
      log.warn(`Display not reachable yet (attempt ${attempt}/${d.connectAttempts}): ${err.message}`);
      if (attempt < d.connectAttempts) await sleep(5000);
    }
  }
  throw new Error(`Could not connect to the display at ${d.host}:${d.port} (${lastErr?.message}). Is it on the network and is MDC enabled?`);
}

// Returns { battery } on success; throws when the display never fetched the image.
export async function pushToDisplay(cfg, server, png) {
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
        log.info(`Asking the display to download ${push.contentUrl}`);
        await withTimeout(device.setContentDownload({ url: push.contentUrl }), 15000, 'Sending the content URL');
      } finally {
        try { await withTimeout(device.disconnect(), 5000, 'Disconnecting'); } catch { /* ignore */ }
        destroy(device);
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

export async function readDisplayInfo(cfg) {
  const device = await connect(cfg);
  try {
    const info = {};
    for (const [key, fn] of [
      ['name', () => device.getDeviceName()],
      ['serial', () => device.getSerialNumber()],
      ['software', () => device.getSoftwareVersion()],
      ['power', () => device.getPowerState()],
      ['battery', () => device.getBatteryState()],
    ]) {
      try {
        info[key] = await withTimeout(fn(), 6000, key);
      } catch (err) {
        info[key] = `(${err.message})`;
      }
    }
    return info;
  } finally {
    try { await withTimeout(device.disconnect(), 5000, 'Disconnecting'); } catch { /* ignore */ }
    destroy(device);
  }
}
