// Configuration, read from environment variables (see .env.example).
import os from 'node:os';

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

function str(name, def = undefined) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return def;
  return String(v).trim();
}

function num(name, def) {
  const v = str(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${v}")`);
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

export function loadConfig() {
  const panelName = (str('PANEL', 'EM32DX') || '').toUpperCase();
  const preset = PANELS[panelName];
  let nativeW = num('PANEL_WIDTH', preset?.width);
  let nativeH = num('PANEL_HEIGHT', preset?.height);
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
  const httpPort = num('HTTP_PORT', 8321);

  const cfg = {
    dataDir: str('DATA_DIR', '/data'),
    albumUrls,
    photoDir: str('PHOTO_DIR'),

    display: {
      host: displayHost,
      port: num('EMDX_PORT', 1515),
      pin: str('EMDX_PIN', '000000'),
      mac: str('EMDX_MAC'),
      wolBroadcast: str('WOL_BROADCAST', '255.255.255.255'),
      wakeWaitSec: num('WAKE_WAIT_SEC', 4),
      connectAttempts: num('CONNECT_ATTEMPTS', 6),
      fetchTimeoutSec: num('FETCH_TIMEOUT_SEC', 180),
      pushAttempts: num('PUSH_ATTEMPTS', 2),
    },

    server: {
      port: httpPort,
      // Address the display uses to download the image from this container.
      publicHost: str('SERVER_HOST') || guessLocalIp(displayHost),
      uiPassword: str('UI_PASSWORD'),
    },

    schedule: str('SCHEDULE', '0 6 * * *'),
    timezone: str('TZ', 'Europe/Brussels'),
    runOnStart: bool('RUN_ON_START', false),
    retryMinutes: num('RETRY_MINUTES', 20),
    retries: num('RETRIES', 3),

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
      oddThreshold: num('ODD_THRESHOLD', 0.35),
      gap: num('PAIR_GAP', 20),
      margin: num('FIT_MARGIN', 48),
    },

    image: {
      dither: oneOf('DITHER', 'local', ['local', 'device']),
      method: oneOf('DITHER_METHOD', 'bluenoise', ['bluenoise', 'diffusion']),
      kernel: oneOf('DITHER_KERNEL', 'floyd-steinberg', ['floyd-steinberg', 'stucki', 'jarvis', 'sierra', 'atkinson']),
      saturation: num('SATURATION', 1.3),
      contrast: num('CONTRAST', 0.25),
      gamma: num('GAMMA', 1.0),
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
    `albums: ${cfg.albumUrls.length}${cfg.photoDir ? `, folder: ${cfg.photoDir}` : ''}`,
    `display: ${d.host || '(EMDX_HOST not set)'}:${d.port}${d.mac ? `, WoL ${d.mac}` : ''}`,
    `panel: ${cfg.panel.name} ${cfg.panel.width}x${cfg.panel.height} (${cfg.panel.orientation}, rotate ${cfg.panel.rotate})`,
    `server: http://${cfg.server.publicHost}:${cfg.server.port}`,
    `schedule: "${cfg.schedule}" (${cfg.timezone})`,
    `image: dither=${cfg.image.dither} method=${cfg.image.method} kernel=${cfg.image.kernel} sat=${cfg.image.saturation} contrast=${cfg.image.contrast}`,
  ].join('\n  ');
}
