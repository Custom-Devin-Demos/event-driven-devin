/**
 * Resolution and notification rules for the Lumen outage notification service.
 *
 * In-memory stand-ins (per yd4-design): CIRCUIT_DIRECTORY for the inventory
 * service, an incident state machine keyed by incidentId, a de-dup set keyed by
 * incidentId+contactId+channel+notificationType (AC-4), and a notification log
 * for the support-agent view (AC-12). A persistent store is a follow-up.
 */

const logger = require('../../telemetry/logger');
const datadog = require('../../telemetry/datadog');
const { render, STATE_WORDS } = require('./templates');
const { gateway } = require('./delivery');
const { optedInContacts } = require('./preferences');

const PORTAL_URL = '/lumen';
const PREFS_URL = '/lumen#notifications';
const SUPPORT_PHONE = '1-877-453-8353';

const FLAP_WINDOW_MS = 15 * 60 * 1000;
const FLAP_THRESHOLD = 3;
const ETA_WINDOW_MS = 30 * 60 * 1000;

const ACCOUNTS = {
  'acct-lumen-1001': { accountId: 'acct-lumen-1001', accountName: 'Northwind Logistics' },
  'acct-lumen-2002': { accountId: 'acct-lumen-2002', accountName: 'Contoso Health' },
};

const CIRCUITS = [
  {
    circuitId: 'ckt-nwl-001',
    circuitName: 'NW-CHI-PRIMARY-10G',
    siteA: 'Chicago DC',
    siteZ: 'Denver DC',
    accountId: 'acct-lumen-1001',
  },
  {
    circuitId: 'ckt-nwl-002',
    circuitName: 'NW-CHI-BACKUP-1G',
    siteA: 'Chicago DC',
    siteZ: 'Kansas City POP',
    accountId: 'acct-lumen-1001',
  },
  {
    circuitId: 'ckt-nwl-003',
    circuitName: 'NW-ATL-10G',
    siteA: 'Atlanta HQ',
    siteZ: 'Ashburn DC',
    accountId: 'acct-lumen-1001',
  },
  {
    circuitId: 'ckt-cto-001',
    circuitName: 'CT-DEN-PRIMARY-10G',
    siteA: 'Denver Campus',
    siteZ: 'Phoenix DC',
    accountId: 'acct-lumen-2002',
  },
  {
    circuitId: 'ckt-cto-002',
    circuitName: 'CT-DEN-CLINIC-1G',
    siteA: 'Denver Campus',
    siteZ: 'Boulder Clinic',
    accountId: 'acct-lumen-2002',
  },
];

const CIRCUIT_DIRECTORY = {};
for (const circuit of CIRCUITS) CIRCUIT_DIRECTORY[circuit.circuitId] = circuit;

let incidents = null;
let dedupKeys = null;
let notificationLog = null;

function seed() {
  incidents = new Map();
  dedupKeys = new Set();
  notificationLog = new Map();
}

function ensure() {
  if (!incidents) seed();
}

function resetStore() {
  seed();
}

function resolveCircuit(circuitId) {
  return CIRCUIT_DIRECTORY[circuitId] || null;
}

function getAccountCircuits(accountId) {
  ensure();
  return CIRCUITS.filter((c) => c.accountId === accountId);
}

function listAccounts() {
  return Object.values(ACCOUNTS).map((a) => ({
    ...a,
    circuits: getAccountCircuits(a.accountId).map((c) => c.circuitId),
  }));
}

function getAccountIncidents(accountId) {
  ensure();
  return [...incidents.values()]
    .filter((i) => i.accountId === accountId)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
}

function getIncident(incidentId) {
  ensure();
  return incidents.get(incidentId) || null;
}

function getNotificationLog(incidentId) {
  ensure();
  const log = notificationLog.get(incidentId) || [];
  return [...log].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
}

function fmtDuration(startedAt, endedAt) {
  const ms = Math.max(0, new Date(endedAt) - new Date(startedAt));
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function historyLines(incident, { newestFirst = false, limit } = {}) {
  let entries = [...incident.history];
  if (newestFirst) entries.reverse();
  if (limit) entries = entries.slice(0, limit);
  return entries.map((e) => `${e.at} - ${e.text}`).join('\n');
}

function addHistory(incident, at, text, { state, backfilled } = {}) {
  const suffix = backfilled ? ' (backfilled)' : '';
  incident.history.push({ at, state: state || null, text: `${text}${suffix}`, backfilled: Boolean(backfilled) });
}

function baseVars(incident, circuit, account) {
  return {
    circuit_id: circuit.circuitId,
    circuit_name: circuit.circuitName || circuit.circuitId,
    site_a: circuit.siteA,
    site_z: circuit.siteZ,
    account_name: account.accountName,
    incident_id: incident.incidentId,
    state: STATE_WORDS[incident.state] || incident.state,
    state_raw: incident.state,
    started_at: incident.startedAt,
    eta: incident.eta,
    eta_updated_at: incident.etaUpdatedAt,
    impact: incident.impact,
    portal_url: PORTAL_URL,
    prefs_url: PREFS_URL,
    support_phone: SUPPORT_PHONE,
  };
}

/**
 * De-dup key is incidentId + contactId + channel + notificationType (AC-4).
 * `variant` distinguishes repeated logical messages of one type that the rules
 * legitimately re-send (an ETA update per 30-min window, a distinct state
 * change); identical repeats still de-dup.
 */
function dedupKey(incidentId, contactId, channel, type, variant) {
  return `${incidentId}|${contactId}|${channel}|${type}${variant ? `|${variant}` : ''}`;
}

/**
 * Send a notification to every opted-in contact on every opted-in channel.
 * Returns { queued, suppressed } counts and appends to the suppressed list and
 * the incident notification log.
 */
function notify(incident, circuit, templateId, type, vars, { now, eventAt, variant, suppressed }) {
  let queued = 0;
  const account = ACCOUNTS[incident.accountId];
  for (const channel of ['email', 'sms', 'webhook']) {
    const contacts = optedInContacts(incident.accountId, channel);
    for (const contact of contacts) {
      const key = dedupKey(incident.incidentId, contact.id, channel, type, variant);
      if (dedupKeys.has(key)) {
        suppressed.push({ contactId: contact.id, channel, type, reason: 'de-dup' });
        datadog.incrementMetric('outage.notifications.suppressed', { reason: 'de-dup', channel });
        continue;
      }
      dedupKeys.add(key);
      const message = render(templateId, vars);
      const result = gateway.enqueue({
        channel,
        recipient: channel === 'email' ? contact.email : contact.id,
        contactId: contact.id,
        incidentId: incident.incidentId,
        type,
        message,
      });
      const entry = {
        incidentId: incident.incidentId,
        contactId: contact.id,
        channel,
        type,
        state: result.state,
        reason: result.reason || null,
        sentAt: result.queuedAt,
      };
      if (!notificationLog.has(incident.incidentId)) notificationLog.set(incident.incidentId, []);
      notificationLog.get(incident.incidentId).push(entry);
      if (result.state === 'queued') {
        queued += 1;
        incident.everNotified = true;
        datadog.incrementMetric('outage.notifications.queued', { channel, type });
        datadog.recordTiming('outage.time_to_notify_ms', Math.max(0, now - eventAt), { type });
      } else {
        suppressed.push({ contactId: contact.id, channel, type, reason: result.reason });
        datadog.incrementMetric('outage.notifications.suppressed', { reason: result.reason, channel });
      }
    }
  }
  logger.info('outage notification batch evaluated', {
    incidentId: incident.incidentId,
    accountId: account.accountId,
    type,
    queued,
  });
  return queued;
}

function createIncident(event) {
  const circuit = resolveCircuit(event.circuitId);
  const incident = {
    incidentId: event.incidentId,
    circuitId: event.circuitId,
    accountId: circuit.accountId,
    state: event.state === 'restored' ? 'restored' : event.state,
    reportedState: event.state,
    startedAt: event.timestamp,
    restoredAt: event.state === 'restored' ? event.timestamp : null,
    eta: event.eta || null,
    etaUpdatedAt: event.eta ? event.timestamp : null,
    impact: event.impact || null,
    history: [],
    transitions: [],
    intermittent: false,
    everNotified: false,
    pendingEtaUpdate: false,
    lastEtaNotifiedAt: new Map(),
    closed: event.state === 'restored',
  };
  addHistory(incident, event.timestamp, `Incident opened ${event.timestamp}`, { state: incident.state });
  if (event.state === 'down' || event.state === 'restored') {
    incident.transitions.push({ at: event.timestamp, state: event.state });
  }
  incidents.set(incident.incidentId, incident);
  return incident;
}

/** Count down/restored transitions inside the flapping window. */
function flapCount(incident, now) {
  return incident.transitions.filter((t) => now - new Date(t.at).getTime() <= FLAP_WINDOW_MS).length;
}

function recordTransition(incident, event) {
  const last = incident.transitions[incident.transitions.length - 1];
  if (!last || last.state !== event.state) {
    incident.transitions.push({ at: event.timestamp, state: event.state });
  }
}

/**
 * ETA rules (AC-5): an eta field on the event is compared with the incident's
 * current ETA. A change writes a history entry and triggers at most one E4 per
 * contact per incident per 30-minute window; a later change inside the window
 * is held (pendingEtaUpdate) and cancelled by a restored event. eta: null after
 * a known ETA is a withdrawal with its own history entry.
 */
function applyEta(incident, circuit, event, { now, backfilled, suppressed }) {
  if (!Object.hasOwn(event, 'eta')) return 0;
  const previous = incident.eta;
  const next = event.eta || null;
  if (next === previous) return 0;

  let queued = 0;
  if (next === null) {
    incident.eta = null;
    incident.etaUpdatedAt = event.timestamp;
    addHistory(incident, event.timestamp, 'ETA withdrawn, we will update when we have a new estimate', { backfilled });
    return 0;
  }
  incident.eta = next;
  incident.etaUpdatedAt = event.timestamp;
  addHistory(incident, event.timestamp, `ETA updated to ${next} (was ${previous || 'none'})`, { backfilled });

  if (backfilled || incident.closed || incident.intermittent) return 0;

  const vars = {
    ...baseVars(incident, circuit, ACCOUNTS[incident.accountId]),
    eta: next,
    eta_updated_at: incident.etaUpdatedAt,
    previous_eta: previous || 'none',
    update_history: historyLines(incident, { newestFirst: true, limit: 3 }),
  };
  const contacts = optedInContacts(incident.accountId, 'email');
  const bucket = Math.floor(now / ETA_WINDOW_MS);
  for (const contact of contacts) {
    const last = incident.lastEtaNotifiedAt.get(contact.id);
    if (last !== undefined && now - last < ETA_WINDOW_MS) {
      incident.pendingEtaUpdate = true;
      suppressed.push({ contactId: contact.id, channel: 'email', type: 'eta_update', reason: 'eta-window' });
      datadog.incrementMetric('outage.notifications.suppressed', { reason: 'eta-window', channel: 'email' });
      continue;
    }
    incident.lastEtaNotifiedAt.set(contact.id, now);
    incident.pendingEtaUpdate = false;
    const key = dedupKey(incident.incidentId, contact.id, 'email', 'eta_update', `${bucket}:${next}`);
    if (dedupKeys.has(key)) continue;
    dedupKeys.add(key);
    const message = render('E4', vars);
    const result = gateway.enqueue({
      channel: 'email',
      recipient: contact.email,
      contactId: contact.id,
      incidentId: incident.incidentId,
      type: 'eta_update',
      message,
    });
    if (!notificationLog.has(incident.incidentId)) notificationLog.set(incident.incidentId, []);
    notificationLog.get(incident.incidentId).push({
      incidentId: incident.incidentId,
      contactId: contact.id,
      channel: 'email',
      type: 'eta_update',
      state: result.state,
      reason: result.reason || null,
      sentAt: result.queuedAt,
    });
    queued += 1;
    incident.everNotified = true;
    datadog.incrementMetric('outage.notifications.queued', { channel: 'email', type: 'eta_update' });
    datadog.recordTiming('outage.time_to_notify_ms', Math.max(0, now - new Date(event.timestamp).getTime()), { type: 'eta_update' });
  }
  return queued;
}

function enterIntermittent(incident, circuit, event, { now, suppressed }) {
  incident.intermittent = true;
  incident.state = 'intermittent';
  addHistory(incident, event.timestamp, 'Circuit is flapping; individual down and restored alerts paused', { state: 'intermittent' });
  const vars = {
    ...baseVars(incident, circuit, ACCOUNTS[incident.accountId]),
    count: flapCount(incident, now),
    update_history: historyLines(incident),
  };
  return notify(incident, circuit, 'E6', 'intermittent', vars, {
    now,
    eventAt: new Date(event.timestamp).getTime(),
    suppressed,
  });
}

/**
 * Apply a normalized event to the store and produce notifications.
 * @returns {{ outcome: string, incidentId: string, notificationsQueued: number,
 *   suppressed: Array }}
 */
function applyEvent(event, { now = Date.now(), backfilled = false } = {}) {
  ensure();
  const suppressed = [];
  const circuit = resolveCircuit(event.circuitId);
  const eventAt = new Date(event.timestamp).getTime();

  if (!circuit) {
    // AC-11: unresolvable circuit — log + counter, nothing customer-visible.
    logger.warn('noc event references unresolvable circuit', {
      circuitId: event.circuitId,
      incidentId: event.incidentId,
      eventId: event.eventId,
    });
    datadog.incrementMetric('outage.notifications.suppressed', { reason: 'unresolved-circuit' });
    return { outcome: 'unresolved-circuit', incidentId: event.incidentId, notificationsQueued: 0, suppressed };
  }

  let incident = incidents.get(event.incidentId);
  const isNew = !incident;
  if (!incident) incident = createIncident(event);

  let queued = 0;

  // Flapping: resume normal rules after 15 minutes of stable state (D4).
  if (incident.intermittent && eventAt - new Date(incident.transitions[incident.transitions.length - 1].at).getTime() > FLAP_WINDOW_MS) {
    incident.intermittent = false;
    incident.state = incident.reportedState;
    addHistory(incident, event.timestamp, 'Circuit stable for 15 minutes; resuming normal alerts');
  }

  // Record the transition before state handling so flap counting sees it.
  if (event.state === 'down' || event.state === 'restored') {
    recordTransition(incident, event);
  }

  if (incident.intermittent) {
    // Held: timeline keeps recording each transition, no individual alerts.
    if (!backfilled) {
      addHistory(incident, event.timestamp, `Reported ${event.state} (alerts paused)`, { state: event.state, backfilled });
    } else {
      addHistory(incident, event.timestamp, `Reported ${event.state} (alerts paused)`, { state: event.state, backfilled: true });
    }
    incident.reportedState = event.state;
    if (event.state === 'restored' && !incident.closed) {
      incident.restoredAt = event.timestamp;
    }
    queued += applyEta(incident, circuit, event, { now, backfilled, suppressed });
    return {
      outcome: backfilled ? 'backfilled' : 'processed',
      incidentId: incident.incidentId,
      notificationsQueued: queued,
      suppressed,
    };
  }

  // Flap check: >3 down/restored transitions in 15 minutes trips suppression.
  if (!incident.closed && flapCount(incident, now) > FLAP_THRESHOLD) {
    queued += enterIntermittent(incident, circuit, event, { now, suppressed });
    return {
      outcome: backfilled ? 'backfilled' : 'processed',
      incidentId: incident.incidentId,
      notificationsQueued: queued,
      suppressed,
    };
  }

  if (isNew && !incident.closed) {
    // First event for the incident: immediate E1/E2 (suppressed only when the
    // event is a replay and the incident was somehow already notified — AC-14
    // still allows a first notification for a never-notified open incident).
    const type = event.state === 'down' ? 'down' : 'degraded';
    const templateId = event.state === 'down' ? 'E1' : 'E2';
    if (!backfilled || !incident.everNotified) {
      queued += notify(incident, circuit, templateId, type, baseVars(incident, circuit, ACCOUNTS[incident.accountId]), {
        now,
        eventAt,
        suppressed,
      });
    } else {
      suppressed.push({ type, reason: 'backfilled' });
    }
    applyEta(incident, circuit, event, { now, backfilled: true, suppressed });
    return {
      outcome: backfilled ? 'backfilled' : 'processed',
      incidentId: incident.incidentId,
      notificationsQueued: queued,
      suppressed,
    };
  }

  if (incident.closed && event.state !== 'restored') {
    // Re-report on a closed incident (same id): keep the portal truthful.
    incident.closed = false;
    incident.state = event.state;
    incident.reportedState = event.state;
    incident.restoredAt = null;
    addHistory(incident, event.timestamp, `Circuit reported ${event.state} again after restore`, { state: event.state, backfilled });
    queued += applyEta(incident, circuit, event, { now, backfilled, suppressed });
    return {
      outcome: backfilled ? 'backfilled' : 'processed',
      incidentId: incident.incidentId,
      notificationsQueued: queued,
      suppressed,
    };
  }

  const prev = incident.reportedState;

  if (event.state === 'restored' && !incident.closed) {
    incident.reportedState = 'restored';
    incident.state = 'restored';
    incident.restoredAt = event.timestamp;
    incident.closed = true;
    incident.pendingEtaUpdate = false; // restored cancels any pending ETA update (AC-5)
    addHistory(incident, event.timestamp, `Restored at ${event.timestamp}`, { state: 'restored', backfilled });
    if (!backfilled) {
      const vars = {
        ...baseVars(incident, circuit, ACCOUNTS[incident.accountId]),
        restored_at: event.timestamp,
        duration: fmtDuration(incident.startedAt, event.timestamp),
      };
      queued += notify(incident, circuit, 'E5', 'restored', vars, { now, eventAt, suppressed });
    }
    return {
      outcome: backfilled ? 'backfilled' : 'processed',
      incidentId: incident.incidentId,
      notificationsQueued: queued,
      suppressed,
    };
  }

  if (event.state === prev) {
    // AC-4: repeated same-state event — liveness history only, no email.
    const word = event.state === 'down' ? 'Still down'
      : event.state === 'degraded' ? 'Still degraded' : 'Restored';
    addHistory(incident, event.timestamp, `${word}, confirmed ${event.timestamp}`, { backfilled });
    queued += applyEta(incident, circuit, event, { now, backfilled, suppressed });
    return {
      outcome: backfilled ? 'backfilled' : 'processed',
      incidentId: incident.incidentId,
      notificationsQueued: queued,
      suppressed,
    };
  }

  if ((prev === 'degraded' && event.state === 'down') || (prev === 'down' && event.state === 'degraded')) {
    incident.reportedState = event.state;
    incident.state = event.state;
    const transition = `${prev}->${event.state}`;
    addHistory(
      incident,
      event.timestamp,
      `State changed ${prev} to ${event.state} at ${event.timestamp}`,
      { state: event.state, backfilled },
    );
    if (!backfilled) {
      const vars = {
        ...baseVars(incident, circuit, ACCOUNTS[incident.accountId]),
        changed_at: event.timestamp,
        previous_state: STATE_WORDS[prev],
        previous_state_raw: prev,
        state: STATE_WORDS[event.state],
        state_raw: event.state,
      };
      const seq = incident.history.length;
      queued += notify(incident, circuit, 'E3', 'state_change', vars, {
        now,
        eventAt,
        variant: `${transition}:${seq}`,
        suppressed,
      });
    }
    queued += applyEta(incident, circuit, event, { now, backfilled, suppressed });
    return {
      outcome: backfilled ? 'backfilled' : 'processed',
      incidentId: incident.incidentId,
      notificationsQueued: queued,
      suppressed,
    };
  }

  // Any other combination: record history and apply ETA rules.
  incident.reportedState = event.state;
  incident.state = event.state;
  addHistory(incident, event.timestamp, `Reported ${event.state} at ${event.timestamp}`, { state: event.state, backfilled });
  queued += applyEta(incident, circuit, event, { now, backfilled, suppressed });
  return {
    outcome: backfilled ? 'backfilled' : 'processed',
    incidentId: incident.incidentId,
    notificationsQueued: queued,
    suppressed,
  };
}

module.exports = {
  ACCOUNTS,
  CIRCUITS,
  CIRCUIT_DIRECTORY,
  PORTAL_URL,
  PREFS_URL,
  SUPPORT_PHONE,
  FLAP_WINDOW_MS,
  FLAP_THRESHOLD,
  ETA_WINDOW_MS,
  resolveCircuit,
  getAccountCircuits,
  getAccountIncidents,
  getIncident,
  getNotificationLog,
  listAccounts,
  applyEvent,
  resetStore,
};
