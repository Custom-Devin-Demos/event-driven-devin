const { AsyncLocalStorage } = require('async_hooks');

/**
 * Per-browser alert destination ("Send alerts to: Slack · Teams · Both").
 *
 * The hubs store the choice in localStorage and mirror it into the
 * `alert_destination` cookie, so every demo page's API request carries it
 * without each vertical forwarding a body field. Absent or unknown values mean
 * Slack, the pre-existing behavior. Nothing here touches server configuration.
 */
const ALERT_DESTINATIONS = ['slack', 'teams', 'both'];
const COOKIE_RE = /(?:^|;\s*)alert_destination=(slack|teams|both)(?=;|$)/;
const storage = new AsyncLocalStorage();

function normalizeAlertDestination(value) {
  return ALERT_DESTINATIONS.includes(value) ? value : null;
}

function alertDestinationFromCookie(cookieHeader) {
  const match = COOKIE_RE.exec(cookieHeader || '');
  return match ? match[1] : null;
}

function runWithAlertDestination(destination, fn) {
  return storage.run({ destination: normalizeAlertDestination(destination) || 'slack' }, fn);
}

function currentAlertDestination() {
  const store = storage.getStore();
  return (store && store.destination) || 'slack';
}

module.exports = {
  ALERT_DESTINATIONS,
  normalizeAlertDestination,
  alertDestinationFromCookie,
  runWithAlertDestination,
  currentAlertDestination,
};
