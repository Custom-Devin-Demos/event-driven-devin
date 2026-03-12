/**
 * Incident Control Layer
 *
 * Manages the current scenario state for the demo app.
 * Scenarios: healthy, slow-db, checkout-regression, dependency-timeout
 */

const VALID_SCENARIOS = ['healthy', 'slow-db', 'checkout-regression', 'dependency-timeout'];

let currentScenario = process.env.APP_SCENARIO || 'healthy';
let scenarioStartedAt = new Date().toISOString();

function getScenario() {
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
  return currentScenario === scenario;
}

module.exports = {
  VALID_SCENARIOS,
  getScenario,
  setScenario,
  getScenarioInfo,
  isScenarioActive,
};
