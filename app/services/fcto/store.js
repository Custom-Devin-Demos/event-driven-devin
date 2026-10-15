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
    this.draft = null;
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

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  persist() {
    this.write(this.load());
  }

  // Run `fn(draft)` exclusively on a copy of the state; the copy becomes the
  // live state only once it is on disk, so a failed write (or a throwing fn)
  // leaves memory and file in agreement.
  transact(fn) {
    const run = this.queue.then(() => {
      const draft = JSON.parse(JSON.stringify(this.load()));
      this.draft = draft;
      try {
        const result = fn(draft);
        this.write(draft);
        this.state = draft;
        return result;
      } finally {
        this.draft = null;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // Reads inside a transaction see the draft, so domain code can look
  // reservations up through the store while mutating.
  current() {
    return this.draft || this.load();
  }

  all() {
    return this.current().reservations.slice();
  }

  get(id) {
    return this.current().reservations.find((r) => r.id === id) || null;
  }

  reset() {
    this.state = emptyState();
    this.persist();
  }
}

module.exports = { ReservationStore, DEFAULT_FILE };
