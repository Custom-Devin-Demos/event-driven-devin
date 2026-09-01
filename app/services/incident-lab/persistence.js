const fs = require('fs');
const path = require('path');
const logger = require('../../telemetry/logger');

/**
 * Incident Lab run-state persistence: a small JSON snapshot of the active
 * run, written on every lifecycle mutation and read back at startup so an
 * armed or declared run survives process restarts (deploys). The file
 * lives under data/, which is volume-mounted in docker-compose so it also
 * survives container replacement.
 */

const DEFAULT_STATE_FILE = path.join(__dirname, '..', '..', '..', 'data', 'incident-lab-run.json');

function stateFile() {
  return process.env.INCIDENT_LAB_STATE_FILE || DEFAULT_STATE_FILE;
}

function saveRunState(snapshot) {
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a torn file.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, file);
  } catch (error) {
    logger.warn('Incident Lab: could not persist run state', { error: error.message });
  }
}

function loadRunState() {
  const file = stateFile();
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    logger.warn('Incident Lab: could not read persisted run state', { error: error.message });
    return null;
  }
}

function clearRunState() {
  const file = stateFile();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (error) {
    logger.warn('Incident Lab: could not clear persisted run state', { error: error.message });
    // Fall back to a stopped tombstone so a failed delete can never be
    // resumed as an active run on the next startup.
    try {
      fs.writeFileSync(file, JSON.stringify({ status: 'stopped' }));
    } catch (tombstoneError) {
      logger.warn('Incident Lab: could not tombstone persisted run state', { error: tombstoneError.message });
    }
  }
}

module.exports = { saveRunState, loadRunState, clearRunState };
