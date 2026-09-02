const fs = require('fs');
const path = require('path');

/**
 * Incident Lab scenario loader. Scenarios are JSON documents under
 * config/incident-lab/ describing a full evolving incident: Datadog
 * telemetry (baseline noise, prelude bursts, outage phases), the scripted
 * Slack persona timeline, phase-gated persona knowledge for the dynamic
 * responder, and the Datadog incident declaration copy.
 */

const SCENARIO_DIR = path.join(__dirname, '..', '..', '..', 'config', 'incident-lab');

function validateScenario(scenario, file) {
  const fail = (msg) => {
    throw new Error(`Invalid incident-lab scenario ${file}: ${msg}`);
  };
  if (!scenario || typeof scenario !== 'object') fail('not an object');
  for (const key of ['id', 'title', 'summary', 'service']) {
    if (typeof scenario[key] !== 'string' || !scenario[key].trim()) fail(`missing "${key}"`);
  }
  if (!Number.isFinite(scenario.durationMs) || scenario.durationMs <= 0) fail('missing "durationMs"');
  if (scenario.leadInMs !== undefined && (!Number.isFinite(scenario.leadInMs) || scenario.leadInMs < 0)) {
    fail('"leadInMs" must be a non-negative number');
  }
  if (!Array.isArray(scenario.personas) || !scenario.personas.length) fail('missing "personas"');
  const personaIds = new Set();
  for (const persona of scenario.personas) {
    if (typeof persona.id !== 'string' || !persona.id.trim()) fail('persona missing "id"');
    if (typeof persona.username !== 'string' || !persona.username.trim()) fail(`persona ${persona.id} missing "username"`);
    if (personaIds.has(persona.id)) fail(`duplicate persona id "${persona.id}"`);
    personaIds.add(persona.id);
  }
  if (!Array.isArray(scenario.script)) fail('missing "script"');
  let lastAt = -1;
  for (const line of scenario.script) {
    if (!Number.isFinite(line.atMs) || line.atMs < 0) fail('script line missing "atMs"');
    if (line.atMs > scenario.durationMs) fail(`script line at ${line.atMs}ms is beyond durationMs`);
    if (line.atMs < lastAt) fail('script lines must be ordered by atMs');
    lastAt = line.atMs;
    if (!personaIds.has(line.persona)) fail(`script line references unknown persona "${line.persona}"`);
    if (typeof line.text !== 'string' || !line.text.trim()) fail('script line missing "text"');
  }
  if (scenario.knowledge != null) {
    if (!Array.isArray(scenario.knowledge)) fail('"knowledge" must be an array');
    for (const entry of scenario.knowledge) {
      if (!Number.isFinite(entry.unlockAtMs)) fail('knowledge entry missing "unlockAtMs"');
      if (entry.unlockAtMs > scenario.durationMs) fail(`knowledge unlock at ${entry.unlockAtMs}ms is beyond durationMs`);
      if (!Array.isArray(entry.facts) || !entry.facts.length) fail('knowledge entry missing "facts"');
    }
  }
  const dd = scenario.datadog;
  if (dd) {
    if (typeof dd.metricPrefix !== 'string' || !dd.metricPrefix.trim()) fail('datadog missing "metricPrefix"');
    const phaseIds = new Set();
    for (const phase of dd.phases || []) {
      if (typeof phase.id !== 'string' || !phase.id.trim()) fail('datadog phase missing "id"');
      if (phaseIds.has(phase.id)) fail(`duplicate datadog phase id "${phase.id}"`);
      phaseIds.add(phase.id);
      if (!phase.manual && !Number.isFinite(phase.startMs)) {
        fail(`datadog phase "${phase.id}" needs "startMs" or "manual": true`);
      }
    }
  }
  return scenario;
}

let cache = null;

function loadScenarios() {
  if (cache) return cache;
  const scenarios = new Map();
  if (!fs.existsSync(SCENARIO_DIR)) {
    cache = scenarios;
    return scenarios;
  }
  for (const file of fs.readdirSync(SCENARIO_DIR)) {
    if (!file.endsWith('.json')) continue;
    const raw = fs.readFileSync(path.join(SCENARIO_DIR, file), 'utf8');
    const scenario = validateScenario(JSON.parse(raw), file);
    if (scenarios.has(scenario.id)) {
      throw new Error(`Duplicate incident-lab scenario id "${scenario.id}"`);
    }
    scenarios.set(scenario.id, scenario);
  }
  cache = scenarios;
  return scenarios;
}

function getScenario(id) {
  return loadScenarios().get(id) || null;
}

function listScenarios() {
  return Array.from(loadScenarios().values()).map((s) => ({
    id: s.id,
    title: s.title,
    summary: s.summary,
    service: s.service,
    durationMs: s.durationMs,
  }));
}

function clearScenarioCache() {
  cache = null;
}

module.exports = { loadScenarios, getScenario, listScenarios, validateScenario, clearScenarioCache };
