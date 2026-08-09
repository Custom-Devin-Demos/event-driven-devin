/**
 * Incident Control Layer
 *
 * Manages the current scenario state for the demo app.
 * Scenarios: healthy, slow-db, checkout-regression, dependency-timeout
 */

const { AsyncLocalStorage } = require('async_hooks');

const VALID_SCENARIOS = ['healthy', 'slow-db', 'checkout-regression', 'dependency-timeout'];

let currentScenario = process.env.APP_SCENARIO || 'healthy';
let scenarioStartedAt = new Date().toISOString();

/**
 * Per-run scenario scoping for the On-Call demos: a degradation registered
 * under a run ref only applies to requests carrying that run's oncall_run
 * cookie (propagated via AsyncLocalStorage), so one presenter's live
 * incident never degrades the site for anyone else. The global scenario
 * (admin endpoint / APP_SCENARIO) still applies to unscoped requests.
 */
const oncallRunContext = new AsyncLocalStorage();
const scopedScenarios = new Map();

/**
 * Per-run runtime config overrides for the On-Call demos. Services read
 * their operational parameters through getScopedConfig(); an override
 * registered under a run ref only applies to requests carrying that run's
 * oncall_run cookie (or synthetic-monitor header), so a responder's
 * mitigation never changes behavior for anyone else's traffic.
 */
const scopedConfigs = new Map();

function runWithOncallRun(runRef, fn) {
  return oncallRunContext.run({ runRef }, fn);
}

function getOncallRunRef() {
  const store = oncallRunContext.getStore();
  return (store && store.runRef) || null;
}

function setScopedScenario(runRef, scenario) {
  if (!VALID_SCENARIOS.includes(scenario)) {
    throw new Error(`Invalid scenario: "${scenario}". Valid: ${VALID_SCENARIOS.join(', ')}`);
  }
  scopedScenarios.set(runRef, scenario);
}

function clearScopedScenario(runRef) {
  scopedScenarios.delete(runRef);
}

function setScopedConfig(runRef, patch) {
  if (!runRef) throw new Error('runRef is required for a scoped config override');
  scopedConfigs.set(runRef, { ...(scopedConfigs.get(runRef) || {}), ...patch });
}

function getScopedConfig() {
  const runRef = getOncallRunRef();
  return (runRef && scopedConfigs.get(runRef)) || {};
}

function clearScopedConfig(runRef) {
  scopedConfigs.delete(runRef);
}

function getScenario() {
  const runRef = getOncallRunRef();
  if (runRef && scopedScenarios.has(runRef)) {
    return scopedScenarios.get(runRef);
  }
  return currentScenario;
}

function setScenario(scenario) {
  if (!VALID_SCENARIOS.includes(scenario)) {
    throw new Error(`Invalid scenario: "${scenario}". Valid: ${VALID_SCENARIOS.join(', ')}`);
  }
  currentScenario = scenario;
  scenarioStartedAt = new Date().toISOString();
  return { scenario: currentScenario, startedAt: scenarioStartedAt };
}

function getScenarioInfo() {
  return {
    scenario: currentScenario,
    startedAt: scenarioStartedAt,
    validScenarios: VALID_SCENARIOS,
  };
}

function isScenarioActive(scenario) {
  return getScenario() === scenario;
}

module.exports = {
  VALID_SCENARIOS,
  getScenario,
  setScenario,
  getScenarioInfo,
  isScenarioActive,
  runWithOncallRun,
  getOncallRunRef,
  setScopedScenario,
  clearScopedScenario,
  setScopedConfig,
  getScopedConfig,
  clearScopedConfig,
};
