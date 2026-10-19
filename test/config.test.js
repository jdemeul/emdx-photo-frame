import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { loadConfig, DEVICE_PALETTE } from '../src/config.js';
import { buildPaletteModel } from '../src/color.js';
import { composeCanvas, renderCanvas } from '../src/render.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('the display does the dithering by default, with gentler tone defaults', () => {
  const dev = withEnv({ DITHER: null, SATURATION: null, CONTRAST: null }, loadConfig);
  assert.equal(dev.image.dither, 'device');
  assert.equal(dev.image.saturation, 1.0);
  assert.equal(dev.image.contrast, 0.1);
  const local = withEnv({ DITHER: 'local', SATURATION: null, CONTRAST: null }, loadConfig);
  assert.equal(local.image.saturation, 1.3);
  assert.equal(local.image.contrast, 0.25);
  const explicit = withEnv({ DITHER: null, SATURATION: '1.2', CONTRAST: null }, loadConfig);
  assert.equal(explicit.image.saturation, 1.2);
});

test('the display sleeps with network standby on by default; deep and off are the alternatives', () => {
  const unset = { SLEEP_MODE: null, SLEEP_DELAY_SEC: null, WAKE_WINDOW_MIN: null };
  const def = withEnv({ ...unset, SLEEP_CHECK_MIN: null }, loadConfig).sleep;
  assert.deepEqual([def.mode, def.delaySec, def.checkMin, def.wakeWindowMin], ['standby', 120, 30, 15]);
  assert.equal(withEnv({ ...unset, SLEEP_CHECK_MIN: '0' }, loadConfig).sleep.checkMin, 0);
  assert.equal(withEnv({ ...unset, SLEEP_MODE: 'Off' }, loadConfig).sleep.mode, 'off');
  assert.equal(withEnv({ ...unset, SLEEP_MODE: 'deep' }, loadConfig).sleep.mode, 'deep');
  assert.throws(() => withEnv({ ...unset, SLEEP_MODE: 'nap' }, loadConfig), /SLEEP_MODE must be one of standby, deep, off/);
});

test('playlist mode looks for the display more often, and tops up no later than the playlist ends', () => {
  const unset = { SLEEP_CHECK_MIN: null, PLAYLIST_DAYS: null, PLAYLIST_TOPUP_DAYS: null };
  const push = withEnv({ ...unset, UPDATE_MODE: null }, loadConfig);
  assert.deepEqual([push.update.mode, push.sleep.checkMin], ['push', 30]);
  const daily = withEnv({ ...unset, UPDATE_MODE: 'playlist' }, loadConfig);
  assert.deepEqual([daily.update.mode, daily.update.days, daily.update.topUpDays, daily.sleep.checkMin], ['playlist', 7, 7, 5]);
  const long = withEnv({ ...unset, UPDATE_MODE: 'playlist', PLAYLIST_DAYS: '30' }, loadConfig);
  assert.deepEqual([long.update.days, long.update.topUpDays], [30, 7]);
  const short = withEnv({ ...unset, UPDATE_MODE: 'playlist', PLAYLIST_DAYS: '3' }, loadConfig);
  assert.equal(short.update.topUpDays, 3);
  assert.throws(() => withEnv({ ...unset, PLAYLIST_DAYS: '90' }, loadConfig), /PLAYLIST_DAYS must be a whole number from 1 to 60/);
});

test('a malformed EMDX_MAC is caught when the config loads', () => {
  assert.equal(withEnv({ EMDX_MAC: '02:00:00:00:00:01' }, loadConfig).display.mac, '02:00:00:00:00:01');
  assert.throws(() => withEnv({ EMDX_MAC: '02:00:00:00:01' }, loadConfig), /EMDX_MAC must be a MAC address/);
});

test('device mode sends the toned photo at panel size, without palette quantisation', async () => {
  const cfg = withEnv({ DITHER: null, ORIENTATION: 'portrait' }, loadConfig);
  const model = buildPaletteModel(cfg.image.measuredPalette, DEVICE_PALETTE);
  const w = 300, h = 400;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { raw[i * 3] = (i % w) * 0.8; raw[i * 3 + 1] = (i / w) * 0.6; raw[i * 3 + 2] = 120; }
  const photo = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
  const canvas = await composeCanvas(cfg, { kind: 'cover', items: [{ width: w, height: h }] }, [photo]);
  const out = await renderCanvas(cfg, model, canvas);
  const { data, info } = await sharp(out.devicePng).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [1440, 2560]);
  const colours = new Set();
  for (let i = 0; i < data.length; i += info.channels * 97) colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  assert.ok(colours.size > 50, `expected a full-colour image, got ${colours.size} colours`);
  assert.equal(out.inkShare, null);
});
