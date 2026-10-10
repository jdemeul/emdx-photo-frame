#!/usr/bin/env node
// emdx-photo-frame — a daily photo from a shared Google Photos album on a Samsung EMDX e-paper display.
//
//   node src/index.js serve            run the scheduler + web UI (default; what the container does)
//   node src/index.js once             show the next photo now, then exit
//   node src/index.js check-album      read the album(s) and print what was found
//   node src/index.js display-info     connect to the display and print name/battery/timer (changes nothing)
//   node src/index.js test-pattern     send the calibration image to the display
//   node src/index.js sleep [mode]     put the display to sleep now (deep | standby; default SLEEP_MODE)
//   node src/index.js sleep-test [min] deep-sleep the display with its timer set a few minutes ahead, and check it wakes
//   node src/index.js render <img...>  render local image files to <DATA_DIR>/render-test (no display needed)
import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { loadConfig, describeConfig, DEVICE_PALETTE } from './config.js';
import { log, stamp } from './log.js';
import { Store } from './state.js';
import { buildPaletteModel } from './color.js';
import { FrameApp } from './app.js';
import { createServer } from './server.js';
import { fetchAlbum } from './sources/googleAlbum.js';
import { readDisplayInfo, putToSleep, probeDisplay } from './display.js';
import { wakeTimeFor, timeOfDay } from './schedule.js';
import { composeCanvas, renderCanvas } from './render.js';

process.on('unhandledRejection', (err) => log.error('Unhandled error:', err));

// A display in deep sleep doesn't answer at all; say what to do about it.
function asleepHint(err) {
  if (err.unreachable) err.message = `${err.what}. Is it on the network? If it is in deep sleep, press its power button first.`;
  throw err;
}

async function main() {
  const [cmd = 'serve', ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  const model = buildPaletteModel(cfg.image.measuredPalette, DEVICE_PALETTE);

  if (cmd === 'check-album') {
    if (!cfg.albumUrls.length) throw new Error('Set ALBUM_URLS first');
    for (const url of cfg.albumUrls) {
      const a = await fetchAlbum(url);
      const portrait = a.items.filter((it) => it.height > it.width).length;
      console.log(`\n"${a.title}" — ${a.items.length} items (${portrait} portrait, ${a.items.length - portrait} landscape/square), ${a.pages} page(s)`);
      for (const it of a.items.slice(0, 5)) {
        console.log(`  ${it.takenAt ? new Date(it.takenAt).toISOString().slice(0, 10) : '????-??-??'}  ${it.width}x${it.height}  ${it.id.slice(0, 16)}…`);
      }
    }
    return;
  }

  if (cmd === 'display-info') {
    console.log(await readDisplayInfo(cfg).catch(asleepHint));
    return;
  }

  if (cmd === 'sleep') {
    const mode = args[0] || cfg.sleep.mode;
    if (!['deep', 'standby'].includes(mode)) throw new Error('Usage: sleep [deep|standby]');
    const wake = mode === 'deep' ? wakeTimeFor(cfg) : null;
    await putToSleep(cfg, { mode, wake }).catch(asleepHint);
    log.info(mode === 'deep' ? `Display is in deep sleep; its timer wakes it at ${wake.label}.` : 'Display is asleep with network standby on.');
    return;
  }

  if (cmd === 'sleep-test') {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const minutes = Math.max(2, Number(args[0] || 5));
    const at = new Date(Math.ceil((Date.now() + minutes * 60000) / 60000) * 60000);
    const wake = timeOfDay(cfg, at);
    log.info(`Putting the display into deep sleep with its wake-up timer at ${wake.label}…`);
    await putToSleep(cfg, { mode: 'deep', wake }).catch(asleepHint);
    const sentAt = Date.now();
    const deadline = at.getTime() + 10 * 60000;
    log.info(`Watching for it to fall asleep and wake up again (until ${stamp(new Date(deadline))})…`);
    let slept = false;
    while (Date.now() < deadline) {
      await wait(15000);
      const up = await probeDisplay(cfg);
      if (!up) {
        if (!slept) log.info('It stopped answering: asleep.');
        slept = true;
      } else if (!slept && Date.now() - sentAt > 120000) {
        throw new Error('It still answers 2 minutes after being told to sleep, so it did not go into deep sleep.');
      } else if (slept) {
        const late = Math.round((Date.now() - at.getTime()) / 1000);
        // Waking takes a moment (and we look every 15 s), so up to ~2.5 min late is normal.
        const off = late < -30 || late > 150
          ? ` Its clock looks ${late < 0 ? 'ahead' : 'behind'} by about ${Math.max(1, Math.round(Math.abs(late) / 60))} min: ` +
            'check its time and time zone in the Samsung E-Paper app.'
          : '';
        log.info(`It woke up and answered ${late >= 0 ? `${late} s after` : `${-late} s before`} ${wake.label}. ` +
          `Deep sleep with the wake-up timer works.${off}`);
        // Back to the configured routine (with SLEEP_MODE=off: undo the test, i.e. no timer, network standby on).
        const mode = cfg.sleep.mode === 'deep' ? 'deep' : 'standby';
        const w = mode === 'deep' ? wakeTimeFor(cfg) : null;
        await putToSleep(cfg, { mode, wake: w });
        log.info(w ? `Back to the normal routine: in deep sleep until ${w.label}.` : 'Back to normal: asleep with network standby on.');
        return;
      }
    }
    throw new Error(
      `The display did not wake within 10 minutes of ${wake.label}. Check its time and time zone in the ` +
        'Samsung E-Paper app, or use SLEEP_MODE=standby. Press its power button to wake it, then run ' +
        '"node src/index.js sleep standby" to turn its network standby back on.',
    );
  }

  if (cmd === 'render') {
    if (!args.length) throw new Error('Usage: render <image> [<second image for a pair>]');
    const inputs = args.map((f) => fs.readFileSync(f));
    const sharp = (await import('sharp')).default;
    const metas = await Promise.all(inputs.map((b) => sharp(b).metadata()));
    const items = metas.map((m) => (m.orientation >= 5 ? { width: m.height, height: m.width } : { width: m.width, height: m.height }));
    const plan = { kind: items.length === 2 ? 'pair' : 'cover', items };
    const outDir = path.join(cfg.dataDir, 'render-test');
    fs.mkdirSync(outDir, { recursive: true });
    const canvas = await composeCanvas(cfg, plan, inputs);
    const out = await renderCanvas(cfg, model, canvas);
    fs.writeFileSync(path.join(outDir, 'device.png'), out.devicePng);
    fs.writeFileSync(path.join(outDir, 'preview.png'), out.previewPng);
    fs.writeFileSync(path.join(outDir, 'preview.jpg'), out.previewJpg);
    console.log(`Rendered in ${out.ms} ms → ${outDir}/{device,preview}.png  inks: ${JSON.stringify(out.inkShare)}`);
    return;
  }

  const store = new Store(cfg.dataDir);
  const app = new FrameApp(cfg, store, model);
  const server = createServer(cfg, app);
  app.server = server;
  try {
    await server.listen();
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    throw new Error(
      `Port ${cfg.server.port} is already in use` +
        (cmd === 'serve'
          ? ' (by another program, or a second copy of this service). Set HTTP_PORT to a free port.'
          : ', probably by the running photo frame service. Use its web page for this, or stop the service first.'),
    );
  }
  log.info(`Config:\n  ${describeConfig(cfg)}`);
  if (!cfg.display.host) log.warn('EMDX_HOST is not set: dry run, photos will be rendered but not sent.');
  if (!cfg.albumUrls.length && !cfg.photoDir) log.warn('Neither ALBUM_URLS nor PHOTO_DIR is set: there is nothing to show yet.');

  if (cmd === 'once' || cmd === 'test-pattern') {
    try {
      if (cmd === 'once') await app.next('manual');
      else await app.testPattern();
      await app.flushSleep();
    } finally {
      await server.close();
    }
    return;
  }

  if (cmd !== 'serve') throw new Error(`Unknown command "${cmd}"`);
  const job = new Cron(cfg.schedule, { timezone: cfg.timezone, protect: true }, () => app.scheduled());
  app.cron = job;
  log.info(`Next update: ${job.nextRun()?.toISOString()} (UI: http://${cfg.server.publicHost}:${cfg.server.port}/)`);
  if (cfg.runOnStart) app.scheduled('start');

  const stop = async (sig) => {
    log.info(`${sig} received, shutting down`);
    job.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  log.error(err);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
