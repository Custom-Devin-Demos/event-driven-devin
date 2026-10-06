const { AsyncLocalStorage } = require('async_hooks');

/**
 * Per-browser alert destination ("Send my demo alerts to: Slack · Teams").
 *
 * The hubs store the choice in localStorage and mirror it into the
 * `alert_destination` cookie, so every demo page's API request carries it
 * without each vertical forwarding a body field. Absent or unknown values mean
 * Slack, the pre-existing behavior. Nothing here touches server configuration.
 */
const ALERT_DESTINATIONS = ['slack', 'teams'];
const COOKIE_RE = /(?:^|;\s*)alert_destination=(slack|teams)(?=;|$)/;
const storage = new AsyncLocalStorage();

function normalizeAlertDestination(value) {
  return ALERT_DESTINATIONS.includes(value) ? value : null;
}

function alertDestinationFromCookie(cookieHeader) {
  const match = COOKIE_RE.exec(cookieHeader || '');
  return match ? match[1] : null;
}

function runWithAlertDestination(destination, fn) {
  return storage.run({ destination: normalizeAlertDestination(destination) }, fn);
}

/** The browser's explicit choice for this request, or null if it never picked one. */
function selectedAlertDestination() {
  const store = storage.getStore();
  return (store && store.destination) || null;
}

function currentAlertDestination() {
  return selectedAlertDestination() || 'slack';
}

module.exports = {
  ALERT_DESTINATIONS,
  normalizeAlertDestination,
  alertDestinationFromCookie,
  runWithAlertDestination,
  currentAlertDestination,
  selectedAlertDestination,
};
