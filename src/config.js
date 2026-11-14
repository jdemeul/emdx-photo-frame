// Configuration, read from environment variables (see .env.example).
import os from 'node:os';
import path from 'node:path';

// Native (landscape) resolutions of the Samsung EMDX panels.
export const PANELS = {
  EM32DX: { width: 2560, height: 1440 },
  EM13DX: { width: 1600, height: 1200 },
};

// Measured look of the six E Ink Spectra 6 inks (used to *compute* the dither),
// and the "device" colours actually written into the PNG for the display.
// Measured values: the calibrated Spectra 6 palette published by the epdoptimize
// project (github.com/paperlesspaper/epdoptimize). Override with
// PALETTE='{"white":"#c8ccc8", ...}' if you measure your own panel.
export const DEFAULT_MEASURED_PALETTE = {
  black: '#1F2226',
  white: '#B9C7C9',
  red: '#62201E',
  yellow: '#C1BB1E',
  green: '#35563A',
  blue: '#233F8E',
};

export const DEVICE_PALETTE = {
  black: '#000000',
  white: '#FFFFFF',
  red: '#FF0000',
  yellow: '#FFFF00',
  green: '#00FF00',
  blue: '#0000FF',
};

export const INK_NAMES = ['black', 'white', 'red', 'yellow', 'green', 'blue'];

// Readers for one set of settings (the environment, or one frame's share of it). `asked`
// collects the names read, so loadFrames() can tell a setting from a typo.
function readers(env, asked) {
  function str(name, def = undefined) {
    asked?.add(name);
    const v = env[name];
    if (v === undefined || v === null || String(v).trim() === '') return def;
    return String(v).trim();
  }

  // A number; `min`/`max`/`int` bound it (timers and ports: a negative interval would make Node
  // fire it every millisecond, knocking on the display nonstop).
  function num(name, def, { min = -Infinity, max = Infinity, int = false } = {}) {
    const v = str(name);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${v}")`);
    if (n < min || n > max || (int && !Number.isInteger(n))) {
      const range = max === Infinity ? `at least ${min}` : `from ${min} to ${max}`;
      throw new Error(`${name} must be ${int ? 'a whole number' : 'a number'} ${range} (got "${v}")`);
    }
    return n;
  }

  function bool(name, def) {
    const v = str(name);
    if (v === undefined) return def;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  }

  function oneOf(name, def, allowed) {
    const v = (str(name, def) || '').toLowerCase();
    if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${v}")`);
    return v;
  }

  return { str, num, bool, oneOf };
}
const PORT = { min: 1, max: 65535, int: true };

function parsePalette(json) {
  if (!json) return { ...DEFAULT_MEASURED_PALETTE };
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new Error(`PALETTE is not valid JSON: ${err.message}`);
  }
  const out = { ...DEFAULT_MEASURED_PALETTE };
  for (const [k, v] of Object.entries(obj)) {
    if (!INK_NAMES.includes(k)) throw new Error(`PALETTE: unknown ink "${k}" (use ${INK_NAMES.join(', ')})`);
    if (!/^#?[0-9a-f]{6}$/i.test(v)) throw new Error(`PALETTE: "${k}" must be a hex colour like #B9C7C9`);
    out[k] = v.startsWith('#') ? v : `#${v}`;
  }
  return out;
}

// Pick the local IPv4 address the display should use to reach us: prefer the
// interface on the same /24 as the display, otherwise the first private address.
export function guessLocalIp(displayHost) {
  const candidates = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
    }
  }
  if (displayHost && /^\d+\.\d+\.\d+\.\d+$/.test(displayHost)) {
    const prefix = displayHost.split('.').slice(0, 3).join('.') + '.';
    const same = candidates.find((ip) => ip.startsWith(prefix));
    if (same) return same;
  }
  const priv = candidates.find((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return priv || candidates[0] || '127.0.0.1';
}

// The settings of one frame. `env`: where to read them (default: the environment); `asked`: a Set
// that collects the names of the settings read.
export function loadConfig(env = process.env, asked = null) {
  const { str, num, bool, oneOf } = readers(env, asked);
  const panelName = (str('PANEL', 'EM32DX') || '').toUpperCase();
  const preset = PANELS[panelName];
  let nativeW = num('PANEL_WIDTH', preset?.width, { min: 1, int: true });
  let nativeH = num('PANEL_HEIGHT', preset?.height, { min: 1, int: true });
  if (!nativeW || !nativeH) {
    throw new Error(`Unknown PANEL "${panelName}". Use ${Object.keys(PANELS).join(' or ')}, or set PANEL_WIDTH and PANEL_HEIGHT.`);
  }
  const orientation = oneOf('ORIENTATION', 'landscape', ['landscape', 'portrait']);
  const long = Math.max(nativeW, nativeH);
  const short = Math.min(nativeW, nativeH);
  const width = orientation === 'portrait' ? short : long;
  const height = orientation === 'portrait' ? long : short;

  const rotate = num('ROTATE', 0);
  if (![0, 90, 180, 270].includes(rotate)) throw new Error('ROTATE must be 0, 90, 180 or 270');

  const albumUrls = (str('ALBUM_URLS', str('ALBUM_URL', '')) || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const displayHost = str('EMDX_HOST');
  const mac = str('EMDX_MAC');
  if (mac && mac.replace(/[^0-9a-f]/gi, '').length !== 12) {
    throw new Error(`EMDX_MAC must be a MAC address like 00:11:22:33:44:55 (got "${mac}")`);
  }
  const httpPort = num('HTTP_PORT', 8321, PORT);

  // Default: let the display do the final dithering. On the EM32DX its own algorithm
  // beat the NAS ditherer side by side (deeper colours, quieter dark tones).
  const dither = oneOf('DITHER', 'device', ['device', 'local']);

  // How the photo changes at every SCHEDULE time:
  //   push     - the NAS sends the next photo (the display must be reachable then: mains
  //              power, or network standby with Wake-on-LAN).
  //   playlist - the NAS sends the photos for the coming PLAYLIST_DAYS days at once, as the
  //              display's own playlist, and the display changes the photo itself, also in
  //              deep sleep. It comes online briefly after each change, and the NAS sends a
  //              fresh playlist then when fewer than PLAYLIST_TOPUP_DAYS days are left.
  // The time of the display's daily panel cleaning, for when it can't be read from the display.
  const cleaningRaw = str('CLEANING_TIME');
  const cm = cleaningRaw ? /^(\d{1,2}):(\d{2})$/.exec(cleaningRaw) : null;
  if (cleaningRaw && !(cm && Number(cm[1]) < 24 && Number(cm[2]) < 60)) throw new Error(`CLEANING_TIME must be a time like 05:50 (got "${cleaningRaw}")`);
  const cleaningTime = cm ? { hour: Number(cm[1]), minute: Number(cm[2]) } : null;

  const updateMode = oneOf('UPDATE_MODE', 'push', ['push', 'playlist']);
  // Playlist mode, when a fresh playlist goes out:
  //   every-change - after every change, while the display is briefly online (the default). An
  //                  EM32DX on battery made the first change after a playlist every time, and then
  //                  got stuck in its panel cleaning before the second (8 to 14 Nov 2026); with a
  //                  fresh playlist after every change it changed every morning (17 to 23 Oct).
  //   when-short   - only once fewer than PLAYLIST_TOPUP_DAYS days are left on the display.
  const resend = oneOf('PLAYLIST_RESEND', 'every-change', ['every-change', 'when-short']);
  const notifyUrl = str('NOTIFY_URL');
  if (notifyUrl && !/^https?:\/\//i.test(notifyUrl)) throw new Error(`NOTIFY_URL must be an http(s) address (got "${notifyUrl}")`);
  const playlistDays = num('PLAYLIST_DAYS', 7);
  if (!Number.isInteger(playlistDays) || playlistDays < 1 || playlistDays > 60) {
    throw new Error(`PLAYLIST_DAYS must be a whole number from 1 to 60 (got "${playlistDays}")`);
  }
  // A fresh playlist goes out (when the display is found awake) once fewer days than this are
  // left on it: long playlists then mean a few big downloads instead of one at every chance.
  const topUpDays = num('PLAYLIST_TOPUP_DAYS', 7);
  if (!Number.isInteger(topUpDays) || topUpDays < 1 || topUpDays > 60) {
    throw new Error(`PLAYLIST_TOPUP_DAYS must be a whole number from 1 to 60 (got "${topUpDays}")`);
  }

  const cfg = {
    // Which frame this is (several frames: see loadFrames()).
    frame: { id: 'main', name: str('FRAME_NAME', 'Photo frame') },
    dataDir: str('DATA_DIR', '/data'),
    // Where to POST a line of text when the frame needs a hand (ntfy.sh style), or nothing.
    notifyUrl,
    albumUrls,
    photoDir: str('PHOTO_DIR'),

    display: {
      host: displayHost,
      port: num('EMDX_PORT', 1515, PORT),
      pin: str('EMDX_PIN', '000000'),
      mac,
      wolBroadcast: str('WOL_BROADCAST', '255.255.255.255'),
      wolPort: num('WOL_PORT', 9, PORT),
      wakeWaitSec: num('WAKE_WAIT_SEC', 4, { min: 0 }),
      connectAttempts: num('CONNECT_ATTEMPTS', 6, { min: 1, int: true }),
      fetchTimeoutSec: num('FETCH_TIMEOUT_SEC', 180, { min: 1 }),
      pushAttempts: num('PUSH_ATTEMPTS', 2, { min: 1, int: true }),
      // Deep sleep: how long a button on the page waits for a display that is just waking up.
      awakeWindowSec: 30,
      // How long the NAS keeps trying to reach the display to send it to sleep.
      sleepWindowSec: 60,
      // A quick look (no Wake-on-LAN): how long to wait for the connection. Longer than the ~8 s
      // Linux takes to report "host unreachable" for an address it had seen recently (stale ARP
      // entry: 5 s delay + 3 probes), else a display off the Wi-Fi times out and passes for one
      // still on it.
      probeTimeoutSec: 10,
      // The daily panel cleaning ("screen protection" in the Samsung app). The NAS reads its time
      // from the display; CLEANING_TIME (hh:mm) stands in when the display doesn't say.
      cleaningTime,
    },

    server: {
      port: httpPort,
      // Address the display uses to download the image from this container.
      publicHost: str('SERVER_HOST') || guessLocalIp(displayHost),
      uiPassword: str('UI_PASSWORD'),
    },

    schedule: str('SCHEDULE', '0 6 * * *'),
    timezone: str('TZ', 'Europe/Brussels'),

    update: {
      mode: updateMode,
      days: playlistDays,
      resend,
      topUpDays: Math.min(topUpDays, playlistDays),
      // Below this, the photo for now isn't sent: the next one shows a little early instead.
      minFirstSec: 600,
      // A shorter tail (the gap that keeps a repeating playlist on time) is left out.
      minTailSec: 300,
      // After a change: how often to look for the display (see WAKE_WINDOW_MIN).
      watchEverySec: 10,
      // The sleep check leaves the display alone this long before and after each change: it
      // wakes up by itself then (to change the photo, maybe for its daily screen refresh).
      quietSec: 15 * 60,
      // ... and from this long before its daily panel cleaning until this long after it starts
      // (how long the cleaning takes is unknown; the router once saw the display online for 5 min).
      cleaningQuietSec: [15 * 60, 30 * 60],
    },
    runOnStart: bool('RUN_ON_START', false),
    retryMinutes: num('RETRY_MINUTES', 20, { min: 1 }),
    retries: num('RETRIES', 3, { min: 0, int: true }),

    // What the display does once a photo (or playlist) is up.
    //   standby - power off with its Wi-Fi listener (network standby) on, so the next update
    //             can wake it with Wake-on-LAN. The listener costs about 1.5% battery an hour,
    //             and on battery the EM32DX stops hearing Wake-on-LAN after many hours.
    //   deep    - network standby off, then power off: hardly any battery use, but nothing on
    //             the network wakes it. Best with UPDATE_MODE=playlist.
    //   off     - leave it to the display's own settings (e.g. when it is on mains power)
    sleep: {
      mode: oneOf('SLEEP_MODE', 'standby', ['standby', 'deep', 'off']),
      delaySec: num('SLEEP_DELAY_SEC', 120, { min: 0 }), // let the panel finish redrawing first
      // Every this many minutes, check that the display is really asleep, and whether it is
      // off the Wi-Fi (0 = never). Every check knocks on the display's door, so not too often.
      checkMin: num('SLEEP_CHECK_MIN', 30, { min: 0 }),
      // Playlist mode with deep sleep: how long the display gets to go to sleep by itself after
      // an update before the sleep check looks at it (its own Sleep After is 10 min or so).
      ownSleepSec: 15 * 60,
      // "Deep sleep now": once asleep, look whether it is off the Wi-Fi after these pauses (s).
      offWifiChecksSec: [15, 15, 30, 60, 120, 240],
      // SLEEP_MODE=deep: asleep but still on the Wi-Fi at this many sleep checks in a row is a
      // light sleep, and the NAS puts the display into deep sleep. (Three: after an update the
      // EM32DX stays on the Wi-Fi for half an hour to an hour before it drops off by itself.)
      lightSleepChecks: 3,
      // Playlist mode: how long the NAS looks for the display after each change.
      wakeWindowMin: num('WAKE_WINDOW_MIN', 15, { min: 0.01 }),
      // Playlist mode: after a change the display missed (it didn't come online), look for it
      // this often (s; no Wake-on-LAN), to send it a fresh playlist as soon as it is back, e.g.
      // after a press on its power button (it then stays awake for its Sleep After, 10 min).
      // 0 = only at the regular sleep checks.
      missedCheckSec: num('MISSED_CHECK_SEC', 60, { min: 0 }),
      confirmSec: 150, // after a sleep command, how long to wait for it to stop answering
      confirmEverySec: 15,
    },

    panel: {
      name: panelName,
      width,
      height,
      orientation,
      rotate,
    },

    layout: {
      odd: oneOf('ODD_PHOTOS', 'pair', ['pair', 'crop', 'fit']),
      // A photo counts as "odd" when filling the whole frame would crop away more than this fraction.
      oddThreshold: num('ODD_THRESHOLD', 0.35, { min: 0, max: 1 }),
      gap: num('PAIR_GAP', 20, { min: 0, int: true }),
      margin: num('FIT_MARGIN', 48, { min: 0, int: true }),
    },

    image: {
      dither,
      method: oneOf('DITHER_METHOD', 'bluenoise', ['bluenoise', 'diffusion']),
      kernel: oneOf('DITHER_KERNEL', 'floyd-steinberg', ['floyd-steinberg', 'stucki', 'jarvis', 'sierra', 'atkinson']),
      // The display boosts colour itself, so start gentler when it does the dithering.
      saturation: num('SATURATION', dither === 'device' ? 1.0 : 1.3, { min: 0 }),
      contrast: num('CONTRAST', dither === 'device' ? 0.1 : 0.25),
      gamma: num('GAMMA', 1.0, { min: 0.1, max: 10 }),
      autoLevels: bool('AUTO_LEVELS', true),
      sharpen: num('SHARPEN', 0.8),
      measuredPalette: parsePalette(str('PALETTE')),
      outputColors: oneOf('OUTPUT_COLORS', 'device', ['device', 'measured']),
    },
  };

  return cfg;
}

export function describeConfig(cfg) {
  const d = cfg.display;
  return [
    `frame: ${cfg.frame.name}, data in ${cfg.dataDir}`,
    `albums: ${cfg.albumUrls.length}${cfg.photoDir ? `, folder: ${cfg.photoDir}` : ''}`,
    `display: ${d.host || '(EMDX_HOST not set)'}:${d.port}${d.mac ? `, WoL ${d.mac}` : ''}`,
    `panel: ${cfg.panel.name} ${cfg.panel.width}x${cfg.panel.height} (${cfg.panel.orientation}, rotate ${cfg.panel.rotate})`,
    `server: http://${cfg.server.publicHost}:${cfg.server.port}`,
    `schedule: "${cfg.schedule}" (${cfg.timezone}), sleep: ${cfg.sleep.mode}`,
    cfg.update.mode === 'playlist'
      ? `updates: playlist of ${cfg.update.days} day${cfg.update.days === 1 ? '' : 's'} (a fresh one ${cfg.update.resend === 'every-change' ? 'after every change' : `when fewer than ${cfg.update.topUpDays} are left`}), the display changes the photo at each SCHEDULE time`
      : 'updates: the NAS sends a photo at each SCHEDULE time',
    `image: dither=${cfg.image.dither} method=${cfg.image.method} kernel=${cfg.image.kernel} sat=${cfg.image.saturation} contrast=${cfg.image.contrast}`,
  ].join('\n  ');
}

// Settings that belong to the service, not to one frame: a frame can't have its own.
const SHARED = ['HTTP_PORT', 'SERVER_HOST', 'UI_PASSWORD', 'TZ', 'FRAMES', 'DEBUG'];

// The frames this service looks after: [{ id, name, cfg }].
//
// One frame (no FRAMES): the settings as they are, state in DATA_DIR.
// Several: FRAMES=hall,kitchen names them, and any setting can be given per frame with the
// frame's name in front (HALL_EMDX_HOST, HALL_EMDX_PIN, KITCHEN_ORIENTATION, HALL_NAME for the
// page...); a setting without a prefix holds for every frame. Each frame keeps its own state,
// in DATA_DIR/frames/<id>, and its own round of the album.
export function loadFrames(env = process.env) {
  const asked = new Set();
  const base = loadConfig(env, asked);
  const ids = String(env.FRAMES || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!ids.length) return [{ id: base.frame.id, name: base.frame.name, cfg: base }];
  const frames = [];
  for (const id of ids) {
    if (!/^[a-z][a-z0-9]*$/.test(id)) throw new Error(`FRAMES: "${id}" is not a usable name (letters and digits, starting with a letter)`);
    if (frames.some((f) => f.id === id)) throw new Error(`FRAMES names "${id}" twice`);
    const prefix = `${id.toUpperCase()}_`;
    const clash = [...asked].find((name) => name.startsWith(prefix));
    if (clash) throw new Error(`FRAMES: "${id}" can't be a frame's name, as ${prefix}… would be mistaken for the setting ${clash}`);
    const own = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
    for (const k of Object.keys(own)) {
      if (SHARED.includes(k)) throw new Error(`${prefix}${k}: ${k} is shared by all frames; set it without the prefix`);
      if (k !== 'NAME' && !asked.has(k)) throw new Error(`${prefix}${k}: there is no setting called ${k}`);
    }
    const cfg = loadConfig({ ...env, DATA_DIR: path.join(base.dataDir, 'frames', id), ...own });
    cfg.frame = { id, name: String(own.NAME || '').trim() || id[0].toUpperCase() + id.slice(1) };
    frames.push({ id, name: cfg.frame.name, cfg });
  }
  const hosts = frames.map((f) => f.cfg.display.host).filter(Boolean);
  const twice = hosts.find((h, i) => hosts.indexOf(h) !== i);
  if (twice) throw new Error(`Two frames have the same display address (${twice}): give each its own <NAME>_EMDX_HOST`);
  // One web server for all: every frame downloads from the same address.
  const server = { ...base.server, publicHost: readers(env).str('SERVER_HOST') || guessLocalIp(hosts[0]) };
  for (const f of frames) f.cfg.server = server;
  return frames;
}
