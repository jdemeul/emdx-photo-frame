#!/usr/bin/env node
// emdx-photo-frame — a daily photo from a shared Google Photos album on a Samsung EMDX e-paper display.
//
//   node src/index.js serve            run the scheduler + web UI (default; what the container does)
//   node src/index.js once             show the next photo now (playlist mode: send the playlist), then exit
//   node src/index.js check-album      read the album(s) and print what was found
//   node src/index.js display-info     connect to the display and print name/battery/network standby/clock/timer 1 (changes nothing)
//   node src/index.js test-pattern     send the calibration image to the display
//   node src/index.js sleep            put the display to sleep now (network standby as SLEEP_MODE says, power off)
//   node src/index.js sleep-test [min] put the display to sleep, wait [min] more minutes, check Wake-on-LAN wakes it
//   node src/index.js playlist-test [m,m,..] send numbered cards as a playlist and watch how the display plays them
//   node src/index.js render <img...>  render local image files to <DATA_DIR>/render-test (no display needed)
import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { loadConfig, describeConfig, DEVICE_PALETTE } from './config.js';
import { log } from './log.js';
import { Store } from './state.js';
import { buildPaletteModel } from './color.js';
import { FrameApp } from './app.js';
import { createServer } from './server.js';
import { fetchAlbum } from './sources/googleAlbum.js';
import { readDisplayInfo, putToSleep, confirmAsleep, probeDisplay, sendWakeOnLan } from './display.js';
import { composeCanvas, renderCanvas } from './render.js';

process.on('unhandledRejection', (err) => log.error('Unhandled error:', err));

// A sleeping display that Wake-on-LAN doesn't reach answers nothing; say what to do about it.
function asleepHint(err) {
  if (err.unreachable) err.message = `${err.what}. Is it on the network? If it is asleep and Wake-on-LAN doesn't reach it, press its power button first.`;
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

  // Put the display to sleep, then wait until it stops answering (the same check the
  // service makes after every update). Network standby stays on unless SLEEP_MODE=deep.
  const sleepAndConfirm = async ({ networkStandby = cfg.sleep.mode !== 'deep' } = {}) => {
    await putToSleep(cfg, { networkStandby }).catch(asleepHint);
    const { confirmSec, confirmEverySec } = cfg.sleep;
    const after = await confirmAsleep(cfg, { timeoutSec: confirmSec, everySec: confirmEverySec });
    if (after === null) throw new Error(`The display still answers ${confirmSec} s after the power-off command: it did not go to sleep.`);
    return after;
  };

  if (cmd === 'sleep') {
    const after = await sleepAndConfirm();
    log.info(`Display is asleep (it stopped answering after ${after} s), with network standby ${cfg.sleep.mode === 'deep' ? 'off' : 'on'}.`);
    return;
  }

  // Can the NAS wake the display? Put it to sleep, wait until it stops answering (and
  // then [minutes] more: some displays stop hearing Wake-on-LAN only after a while),
  // then try Wake-on-LAN for 90 s.
  if (cmd === 'sleep-test') {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const minutes = Math.max(0, Number(args[0] || 0));
    if (!Number.isFinite(minutes)) throw new Error('Usage: sleep-test [minutes]');
    if (!cfg.display.mac) throw new Error('Set EMDX_MAC first: Wake-on-LAN is how the NAS wakes the display.');

    log.info('Putting the display to sleep (network standby on)…');
    log.info(`It stopped answering after ${await sleepAndConfirm({ networkStandby: true })} s: asleep.`);
    if (minutes) {
      log.info(`Letting it sleep for ${minutes} more minute${minutes === 1 ? '' : 's'}…`);
      await wait(minutes * 60000);
    }
    log.info('Waking it with Wake-on-LAN…');
    const start = Date.now();
    while (Date.now() - start < 90000) {
      await sendWakeOnLan(cfg);
      await wait(5000);
      if (await probeDisplay(cfg)) {
        log.info(`Wake-on-LAN woke it after ${Math.round((Date.now() - start) / 1000)} s.`);
        log.info(`Back to sleep (it stopped answering after ${await sleepAndConfirm({ networkStandby: true })} s).`);
        return;
      }
    }
    throw new Error(
      'Wake-on-LAN did not wake it. Check EMDX_MAC, and try WOL_BROADCAST set to your network\'s broadcast ' +
        'address (e.g. 192.168.1.255). Press its power button to wake it.',
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

  if (cmd === 'once' || cmd === 'test-pattern' || cmd === 'playlist-test') {
    try {
      if (cmd === 'once') await (app.daily ? app.resend() : app.next('manual'));
      else if (cmd === 'test-pattern') await app.testPattern();
      else {
        const minutes = args[0] ? args[0].split(',').map(Number) : null;
        if (minutes && (minutes.length < 2 || minutes.length > 4 || minutes.some((m) => !(m > 0)))) {
          throw new Error('Usage: playlist-test [minutes per card, 2 to 4 cards], e.g. playlist-test 10,20,20,20');
        }
        const t = await app.playlistTest(minutes ? { minutes } : {});
        console.log(t.result?.verdict || 'No result.');
      }
      await app.flushSleep();
    } finally {
      await server.close();
    }
    return;
  }

  if (cmd !== 'serve') throw new Error(`Unknown command "${cmd}"`);
  const job = new Cron(cfg.schedule, { timezone: cfg.timezone, protect: true }, () => app.scheduled());
  app.cron = job;
  app.startSleepWatch();
  log.info(`Next ${app.daily ? 'change' : 'update'}: ${job.nextRun()?.toISOString()} (UI: http://${cfg.server.publicHost}:${cfg.server.port}/)`);
  if (app.daily) app.daily.startup({ send: cfg.runOnStart }).catch((err) => log.error('Playlist:', err));
  else if (cfg.runOnStart) app.scheduled('start');

  const stop = async (sig) => {
    log.info(`${sig} received, shutting down`);
    job.stop();
    app.stopSleepWatch();
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
