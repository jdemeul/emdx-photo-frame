// Small JSON state file in the data volume. Written to a temporary file, flushed to disk and
// renamed over the old one; the one before that stays as state.json.bak, so a file torn by a
// power cut or a full disk costs one save, not the whole state (which round of the album, the
// plan, what the display has).
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

const fresh = () => ({ version: 1, bag: [], shownThisCycle: [], cycle: 0, excluded: {}, history: [] });

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.backup = `${this.file}.bak`;
    fs.mkdirSync(path.join(dataDir, 'current'), { recursive: true });
    this.state = this.load();
  }

  load() {
    for (const file of [this.file, this.backup]) {
      try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('not a state object');
        if (file === this.backup) log.warn(`Using the previous copy of the state (${path.basename(file)})`);
        return state;
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`Could not read ${path.basename(file)} (${err.message})`);
      }
    }
    if (fs.existsSync(this.file) || fs.existsSync(this.backup)) log.warn('Starting with a fresh state');
    return fresh();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(this.state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.renameSync(this.file, this.backup); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    fs.renameSync(tmp, this.file);
  }

  path(...parts) {
    return path.join(this.dir, ...parts);
  }
}
