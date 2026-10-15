'use strict';

// JSON-file persistence for Field CTO reservations. Lives in /data, which
// docker-compose mounts as a host volume so reservations survive redeploys
// (same place as the webinar signup capture). Writes are serialized and
// atomic (tmp file + rename).

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'data', 'fcto-reservations.json');

function emptyState() {
  return { version: 1, nextSeq: 1, reservations: [] };
}

class ReservationStore {
  constructor(file = process.env.FCTO_STORE_FILE || DEFAULT_FILE) {
    this.file = file;
    this.state = null;
    this.queue = Promise.resolve();
  }

  load() {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = {
        version: 1,
        nextSeq: Number.isInteger(parsed.nextSeq) && parsed.nextSeq > 0 ? parsed.nextSeq : 1,
        reservations: Array.isArray(parsed.reservations) ? parsed.reservations : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupt file must not silently become an empty roster; keep it
        // aside and start fresh so the app stays up.
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      this.state = emptyState();
    }
    return this.state;
  }

  persist() {
    const state = this.load();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Run `fn(state)` exclusively; whatever it returns is the result. State is
  // persisted after every mutation.
  transact(fn) {
    const run = this.queue.then(() => {
      const state = this.load();
      const result = fn(state);
      this.persist();
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  all() {
    return this.load().reservations.slice();
  }

  get(id) {
    return this.load().reservations.find((r) => r.id === id) || null;
  }

  reset() {
    this.state = emptyState();
    this.persist();
  }
}

module.exports = { ReservationStore, DEFAULT_FILE };
