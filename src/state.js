// Small JSON state file in the data volume (written atomically).
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(path.join(dataDir, 'current'), { recursive: true });
    this.state = this.load();
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not read state (${err.message}); starting fresh`);
      return { version: 1, bag: [], shownThisCycle: [], cycle: 0, excluded: {}, history: [] };
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  path(...parts) {
    return path.join(this.dir, ...parts);
  }
}
