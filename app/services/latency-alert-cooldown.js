const DEFAULT_COOLDOWN_MS = Number(process.env.LATENCY_ALERT_COOLDOWN_MS) || 10 * 60 * 1000;
const latencyAlertClaims = new Map();
let nextClaimToken = 1;

function claimLatencyAlert(key, cooldownMs = DEFAULT_COOLDOWN_MS) {
  const now = Date.now();
  const existingClaim = latencyAlertClaims.get(key);
  if (existingClaim && now - existingClaim.at <= cooldownMs) {
    return null;
  }
  const token = nextClaimToken++;
  latencyAlertClaims.set(key, { at: now, token });
  return token;
}

function releaseLatencyAlert(key, token) {
  if (latencyAlertClaims.get(key)?.token === token) {
    latencyAlertClaims.delete(key);
  }
}

function latencyAlertKey(verticalId, orgId) {
  return `${verticalId}:${orgId || 'default'}`;
}

function startedInvestigation(result) {
  return Boolean(result && (result.session || result.incident || result.teams));
}

function resetLatencyAlertCooldowns() {
  latencyAlertClaims.clear();
}

module.exports = {
  latencyAlertKey,
  claimLatencyAlert,
  releaseLatencyAlert,
  startedInvestigation,
  resetLatencyAlertCooldowns,
  DEFAULT_COOLDOWN_MS,
};
