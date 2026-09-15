const express = require('express');
const logger = require('../../telemetry/logger');
const datadog = require('../../telemetry/datadog');
const {
  ACCOUNTS,
  STATE_WORDS,
  truncateName,
  formatTimestamp,
  formatCopyText,
  DEFAULT_TIMEZONE,
  ValidationError,
  normalizeEvent,
  processEvent,
  resolveCircuit,
  getAccountCircuits,
  getAccountIncidents,
  getIncident,
  getNotificationLog,
  listAccounts,
  getPreferences,
  setChannel,
  resetStore,
  resetQueue,
  resetPreferences,
  resetProcessedEvents,
} = require('../../services/outage-notifications');

const router = express.Router();

const RESTORED_BANNER_WINDOW_MS = 24 * 60 * 60 * 1000;

function circuitState(circuitId, incidents) {
  const open = incidents.find((i) => i.circuitId === circuitId && !i.closed);
  if (open) return open.state;
  return 'healthy';
}

function etaShort(incident, timeZone) {
  return incident.eta ? `Estimated restore ${formatTimestamp(incident.eta, timeZone)}` : 'ETA not yet available';
}

function incidentLabel(iso, timeZone) {
  return iso ? formatTimestamp(iso, timeZone) : null;
}

function buildBanner(incidents) {
  const open = incidents.filter((i) => !i.closed);
  const intermittent = open.find((i) => i.state === 'intermittent');
  if (intermittent) {
    const name = truncateName(resolveCircuitName(intermittent.circuitId));
    return {
      variant: 'intermittent',
      text: `Intermittent: ${name} (${intermittent.circuitId}) has been unstable since ${formatTimestamp(intermittent.startedAt, DEFAULT_TIMEZONE)}. Individual alerts paused.`,
      incidentId: intermittent.incidentId,
    };
  }
  if (open.length > 1) {
    const worst = open.find((i) => i.state === 'down') || open[0];
    const name = truncateName(resolveCircuitName(worst.circuitId));
    return {
      variant: 'multiple',
      text: `${open.length} circuits have open incidents. Worst: ${STATE_WORDS[worst.state] || worst.state} on ${name}.`,
      incidentId: worst.incidentId,
    };
  }
  if (open.length === 1) {
    const incident = open[0];
    const name = truncateName(resolveCircuitName(incident.circuitId));
    return {
      variant: 'single',
      text: `${STATE_WORDS[incident.state] || incident.state}: ${name} (${incident.circuitId}) since ${formatTimestamp(incident.startedAt, DEFAULT_TIMEZONE)}. ${etaShort(incident, DEFAULT_TIMEZONE)}.`,
      incidentId: incident.incidentId,
    };
  }
  const restored = incidents
    .filter((i) => i.closed && i.restoredAt
      && Date.now() - new Date(i.restoredAt).getTime() <= RESTORED_BANNER_WINDOW_MS)
    .sort((a, b) => new Date(b.restoredAt) - new Date(a.restoredAt))[0];
  if (restored) {
    const name = truncateName(resolveCircuitName(restored.circuitId));
    const duration = restored.restoredAt
      ? formatDuration(restored.startedAt, restored.restoredAt)
      : '';
    return {
      variant: 'restored',
      text: `Restored: ${name} (${restored.circuitId}) back to normal at ${formatTimestamp(restored.restoredAt, DEFAULT_TIMEZONE)}. Duration ${duration}.`,
      incidentId: restored.incidentId,
    };
  }
  return null;
}

function formatDuration(startedAt, endedAt) {
  const ms = Math.max(0, new Date(endedAt) - new Date(startedAt));
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours} h ${minutes % 60} min`;
  return `${minutes} min`;
}

function resolveCircuitName(circuitId) {
  const circuit = resolveCircuit(circuitId);
  return circuit ? circuit.circuitName : circuitId;
}

function circuitIncidentsPayload(accountId) {
  const account = ACCOUNTS[accountId];
  const circuits = getAccountCircuits(accountId);
  const incidents = getAccountIncidents(accountId);
  const openIncidents = incidents.filter((i) => !i.closed);
  return {
    accountId,
    accountName: account.accountName,
    circuits: circuits.map((c) => ({
      circuitId: c.circuitId,
      circuitName: c.circuitName,
      siteA: c.siteA,
      siteZ: c.siteZ,
      state: circuitState(c.circuitId, incidents),
    })),
    incidents: incidents.map((i) => ({
      incidentId: i.incidentId,
      circuitId: i.circuitId,
      circuitName: resolveCircuitName(i.circuitId),
      state: i.state,
      startedAt: i.startedAt,
      startedAtLabel: incidentLabel(i.startedAt, DEFAULT_TIMEZONE),
      restoredAt: i.restoredAt,
      restoredAtLabel: incidentLabel(i.restoredAt, DEFAULT_TIMEZONE),
      eta: i.eta,
      etaLabel: i.eta ? formatTimestamp(i.eta, DEFAULT_TIMEZONE) : 'ETA not yet available',
      etaUpdatedAt: i.etaUpdatedAt,
      etaUpdatedAtLabel: incidentLabel(i.etaUpdatedAt, DEFAULT_TIMEZONE),
      impact: i.impact,
      history: i.history.map((h) => ({
        ...h,
        atLabel: incidentLabel(h.at, DEFAULT_TIMEZONE),
        textLabel: formatCopyText(h.text, DEFAULT_TIMEZONE),
      })),
    })),
    openCount: openIncidents.length,
    banner: buildBanner(incidents),
  };
}

function circuitIncidentsHandler(req, res) {
  const accountId = req.params.id;
  if (!ACCOUNTS[accountId]) {
    return res.status(404).json({ error: 'Unknown account' });
  }
  return res.json(circuitIncidentsPayload(accountId));
}

// Bare path required by the ticket; namespaced twin for the portal UI.
router.get('/accounts/:id/circuit-incidents', circuitIncidentsHandler);
router.get('/api/b6894861/accounts/:id/circuit-incidents', circuitIncidentsHandler);

router.get('/api/b6894861/accounts', (_req, res) => {
  res.json({ accounts: listAccounts() });
});

router.post('/api/b6894861/noc/events', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.events)) {
    return res.status(400).json({ error: 'events must be an array', code: 'VALIDATION_ERROR' });
  }
  // Validate the whole batch first: malformed events are rejected, never
  // partially applied.
  let normalized;
  try {
    normalized = body.events.map((raw) => normalizeEvent(raw));
  } catch (error) {
    if (error instanceof ValidationError || error.code === 'VALIDATION_ERROR') {
      logger.warn('noc event batch rejected', { error: error.message });
      return res.status(400).json({ error: error.message, code: 'VALIDATION_ERROR' });
    }
    throw error;
  }
  const results = normalized.map((event) => processEvent(event));
  return res.json({ accepted: results.length, results });
});

router.get('/api/b6894861/accounts/:id/preferences', (req, res) => {
  const prefs = getPreferences(req.params.id);
  if (!prefs) return res.status(404).json({ error: 'Unknown account' });
  return res.json(prefs);
});

router.put('/api/b6894861/accounts/:id/preferences', (req, res) => {
  const body = req.body || {};
  const { contactId, channel, enabled, actor } = body;
  if (typeof contactId !== 'string' || typeof channel !== 'string' || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'contactId, channel and enabled are required', code: 'VALIDATION_ERROR' });
  }
  const result = setChannel({
    accountId: req.params.id,
    contactId,
    channel,
    enabled,
    actor: typeof actor === 'string' && actor ? actor : 'portal-admin',
  });
  if (!result) return res.status(404).json({ error: 'Unknown account, contact or channel' });
  logger.info('notification preference updated', {
    accountId: req.params.id,
    contactId,
    channel,
    enabled,
  });
  return res.json(result);
});

router.get('/api/b6894861/accounts/:id/incidents/:incidentId/notifications', (req, res) => {
  if (!ACCOUNTS[req.params.id]) return res.status(404).json({ error: 'Unknown account' });
  const incident = getIncident(req.params.incidentId);
  if (!incident || incident.accountId !== req.params.id) {
    return res.status(404).json({ error: 'Unknown incident' });
  }
  return res.json({ incidentId: incident.incidentId, notifications: getNotificationLog(incident.incidentId) });
});

router.post('/api/b6894861/demo/reset', (_req, res) => {
  resetStore();
  resetQueue();
  resetPreferences();
  resetProcessedEvents();
  datadog.incrementMetric('outage.events.processed', { outcome: 'demo-reset' });
  res.json({ ok: true });
});

module.exports = router;
