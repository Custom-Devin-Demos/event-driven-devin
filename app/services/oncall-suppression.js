const { AsyncLocalStorage } = require('async_hooks');

/**
 * Request-scoped suppression of the legacy alert pipeline.
 *
 * On-call mode requests execute the real vertical code path — so Sentry and
 * Datadog capture genuine telemetry — but must not fire the legacy
 * Slack-alert/Devin trigger (`createSessionAndAlert`). The On-Call responders
 * are triggered by the alert card posted to the on-call channels instead.
 */
const storage = new AsyncLocalStorage();

function runWithLegacyAlertsSuppressed(fn) {
  return storage.run({ suppressed: true }, fn);
}

function legacyAlertsSuppressed() {
  const store = storage.getStore();
  return Boolean(store && store.suppressed);
}

module.exports = { runWithLegacyAlertsSuppressed, legacyAlertsSuppressed };
