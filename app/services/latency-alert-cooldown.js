const DEFAULT_COOLDOWN_MS = Number(process.env.LATENCY_ALERT_COOLDOWN_MS) || 10 * 60 * 1000;
const latencyAlertClaims = new Map();

function claimLatencyAlert(key, cooldownMs = DEFAULT_COOLDOWN_MS) {
  const now = Date.now();
  if (latencyAlertClaims.has(key) && now - latencyAlertClaims.get(key) <= cooldownMs) {
    return false;
  }
  latencyAlertClaims.set(key, now);
  return true;
}

function releaseLatencyAlert(key) {
  latencyAlertClaims.delete(key);
}

function resetLatencyAlertCooldowns() {
  latencyAlertClaims.clear();
}

module.exports = {
  claimLatencyAlert,
  releaseLatencyAlert,
  resetLatencyAlertCooldowns,
  DEFAULT_COOLDOWN_MS,
};
