#!/usr/bin/env node
// emdx-photo-frame — a daily photo from a shared Google Photos album on a Samsung EMDX e-paper display.
//
//   node src/index.js serve            run the scheduler + web UI (default; what the container does)
//   node src/index.js once             show the next photo now, then exit
//   node src/index.js check-album      read the album(s) and print what was found
//   node src/index.js display-info     connect to the display and print name/battery (changes nothing)
//   node src/index.js test-pattern     send the calibration image to the display
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
import { readDisplayInfo } from './display.js';
import { composeCanvas, renderCanvas } from './render.js';

process.on('unhandledRejection', (err) => log.error('Unhandled error:', err));

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
    console.log(await readDisplayInfo(cfg));
    return;
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
  await server.listen();
  log.info(`Config:\n  ${describeConfig(cfg)}`);
  if (!cfg.display.host) log.warn('EMDX_HOST is not set: dry run, photos will be rendered but not sent.');
  if (!cfg.albumUrls.length && !cfg.photoDir) log.warn('Neither ALBUM_URLS nor PHOTO_DIR is set: there is nothing to show yet.');

  if (cmd === 'once' || cmd === 'test-pattern') {
    try {
      if (cmd === 'once') await app.next('manual');
      else await app.testPattern();
    } finally {
      await server.close();
    }
    return;
  }

  if (cmd !== 'serve') throw new Error(`Unknown command "${cmd}"`);
  const job = new Cron(cfg.schedule, { timezone: cfg.timezone, protect: true }, () => app.scheduled());
  app.cron = job;
  log.info(`Next update: ${job.nextRun()?.toISOString()} (UI: http://${cfg.server.publicHost}:${cfg.server.port}/)`);
  if (cfg.runOnStart) app.scheduled();

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
