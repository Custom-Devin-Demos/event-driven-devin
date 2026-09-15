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
const { render, STATE_WORDS, formatTimestamp, DEFAULT_TIMEZONE } = require('./templates');
const { gateway } = require('./delivery');
const { optedInContacts, getPreferences } = require('./preferences');

const PORTAL_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const PORTAL_URL = `${PORTAL_BASE_URL}/lumen`;
const PREFS_URL = `${PORTAL_BASE_URL}/lumen#notifications`;
const SUPPORT_PHONE = '1-877-453-8353';

const ISO_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

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

/**
 * Latest open incident on a circuit by startedAt, or null. Used for the
 * circuit row state and the portal's Details target.
 */
function currentIncidentForCircuit(accountId, circuitId) {
  ensure();
  const open = [...incidents.values()]
    .filter((i) => i.accountId === accountId && i.circuitId === circuitId && !i.closed)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return open[0] || null;
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
  if (hours > 0) return `${hours} h ${minutes % 60} min`;
  return `${minutes} min`;
}

/** Rewrite embedded ISO timestamps inside stored copy to a timezone label. */
function formatCopyText(text, timeZone = DEFAULT_TIMEZONE) {
  return String(text).replace(ISO_IN_TEXT, (m) => formatTimestamp(m, timeZone));
}

function contactTz(contact) {
  return (contact && contact.timezone) || DEFAULT_TIMEZONE;
}

function historyLines(incident, { newestFirst = false, limit, timeZone = DEFAULT_TIMEZONE } = {}) {
  let entries = [...incident.history];
  if (newestFirst) entries.reverse();
  if (limit) entries = entries.slice(0, limit);
  return entries
    .map((e) => `${formatTimestamp(e.at, timeZone)} - ${formatCopyText(e.text, timeZone)}`)
    .join('\n');
}

function addHistory(incident, at, text, { state, backfilled, late } = {}) {
  const suffix = backfilled ? ' (backfilled)' : '';
  incident.history.push({
    at,
    state: state || null,
    text: `${text}${suffix}`,
    backfilled: Boolean(backfilled),
    late: Boolean(late),
  });
}

function baseVars(incident, circuit, account, timeZone = DEFAULT_TIMEZONE) {
  return {
    circuit_id: circuit.circuitId,
    circuit_name: circuit.circuitName || circuit.circuitId,
    site_a: circuit.siteA,
    site_z: circuit.siteZ,
    account_name: account.accountName,
    incident_id: incident.incidentId,
    state: STATE_WORDS[incident.state] || incident.state,
    state_raw: incident.state,
    started_at: formatTimestamp(incident.startedAt, timeZone),
    eta: incident.eta ? formatTimestamp(incident.eta, timeZone) : null,
    eta_updated_at: incident.etaUpdatedAt ? formatTimestamp(incident.etaUpdatedAt, timeZone) : null,
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
function notify(incident, circuit, templateId, type, varsFor, { now, eventAt, variant, suppressed }) {
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
      const vars = typeof varsFor === 'function' ? varsFor(contact, contactTz(contact)) : varsFor;
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
    pendingEta: new Map(),
    lastEtaNotifiedAt: new Map(),
    lastEventAt: new Date(event.timestamp).getTime(),
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
 * Send a single E4 ETA update to one contact. De-dup variant is the ETA value
 * itself, so a re-sent identical estimate still de-dups but a new value sends.
 */
function sendEtaUpdate(incident, circuit, contact, { eta, previousEta, now, eventAt }) {
  const key = dedupKey(incident.incidentId, contact.id, 'email', 'eta_update', `${eta}`);
  if (dedupKeys.has(key)) return 0;
  dedupKeys.add(key);
  incident.lastEtaNotifiedAt.set(contact.id, now);
  incident.pendingEta.delete(contact.id);
  const tz = contactTz(contact);
  const vars = {
    ...baseVars(incident, circuit, ACCOUNTS[incident.accountId], tz),
    eta: formatTimestamp(eta, tz),
    eta_updated_at: formatTimestamp(incident.etaUpdatedAt, tz),
    previous_eta: previousEta ? formatTimestamp(previousEta, tz) : 'none',
    update_history: historyLines(incident, { newestFirst: true, limit: 3, timeZone: tz }),
  };
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
  incident.everNotified = true;
  datadog.incrementMetric('outage.notifications.queued', { channel: 'email', type: 'eta_update' });
  datadog.recordTiming('outage.time_to_notify_ms', Math.max(0, now - eventAt), { type: 'eta_update' });
  return 1;
}

/**
 * ETA rules (AC-5): an eta field on the event is compared with the incident's
 * current ETA. A change writes a history entry and triggers at most one E4 per
 * contact per incident per rolling 30-minute window; a later change inside the
 * window is held in incident.pendingEta (coalesced to the latest value) and
 * cancelled by a restored event. eta: null after a known ETA is a withdrawal
 * with its own history entry.
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
    incident.pendingEta.clear(); // a withdrawn ETA cancels any held update
    addHistory(incident, event.timestamp, 'ETA withdrawn, we will update when we have a new estimate', { backfilled });
    return 0;
  }
  incident.eta = next;
  incident.etaUpdatedAt = event.timestamp;
  addHistory(incident, event.timestamp, `ETA updated to ${next} (was ${previous || 'none'})`, { backfilled });

  if (backfilled || incident.closed || incident.intermittent) return 0;

  const contacts = optedInContacts(incident.accountId, 'email');
  for (const contact of contacts) {
    const last = incident.lastEtaNotifiedAt.get(contact.id);
    if (last !== undefined && now - last < ETA_WINDOW_MS) {
      incident.pendingEta.set(contact.id, { eta: next, previousEta: previous, updatedAt: event.timestamp });
      suppressed.push({ contactId: contact.id, channel: 'email', type: 'eta_update', reason: 'eta-window' });
      datadog.incrementMetric('outage.notifications.suppressed', { reason: 'eta-window', channel: 'email' });
      continue;
    }
    queued += sendEtaUpdate(incident, circuit, contact, {
      eta: next,
      previousEta: previous,
      now,
      eventAt: new Date(event.timestamp).getTime(),
    });
  }
  return queued;
}

function findContact(accountId, contactId) {
  const prefs = getPreferences(accountId);
  return prefs ? prefs.contacts.find((c) => c.id === contactId) || null : null;
}

/**
 * Leave intermittent mode once the circuit has been stable for the flap
 * window. A stable restore closes the incident with a single E5; a stable
 * down simply resumes normal alerting (D4).
 */
function settleIntermittent(incident, circuit, now, suppressed = []) {
  const last = incident.transitions[incident.transitions.length - 1];
  incident.intermittent = false;
  const at = new Date(now).toISOString();
  if (last && last.state === 'restored') {
    incident.state = 'restored';
    incident.reportedState = 'restored';
    incident.closed = true;
    incident.restoredAt = last.at;
    addHistory(incident, at, 'Circuit stable for 15 minutes; incident resolved', { state: 'restored' });
    return notify(incident, circuit, 'E5', 'restored', (_contact, tz) => ({
      ...baseVars(incident, circuit, ACCOUNTS[incident.accountId], tz),
      restored_at: formatTimestamp(last.at, tz),
      duration: fmtDuration(incident.startedAt, last.at),
    }), {
      now,
      eventAt: new Date(last.at).getTime(),
      variant: 'intermittent-exit',
      suppressed,
    });
  }
  incident.state = incident.reportedState;
  addHistory(incident, at, 'Circuit stable for 15 minutes; resuming normal alerts');
  return 0;
}

/** True while the last flap transition is still inside the window. */
function isFlapping(incident, now) {
  const last = incident.transitions[incident.transitions.length - 1];
  return !last || now - new Date(last.at).getTime() <= FLAP_WINDOW_MS;
}

/**
 * Periodic housekeeping: flush held ETA updates whose rolling 30-minute
 * window has expired, and settle intermittent incidents that have been stable
 * for the flap window. Called at the top of applyEvent, from the portal GET
 * handler, and on a one-minute interval in the route module.
 */
function sweep(now = Date.now()) {
  ensure();
  for (const incident of incidents.values()) {
    const circuit = resolveCircuit(incident.circuitId);
    if (!circuit) continue;
    for (const [contactId, pending] of [...incident.pendingEta.entries()]) {
      const last = incident.lastEtaNotifiedAt.get(contactId);
      if (last !== undefined && now - last < ETA_WINDOW_MS) continue;
      const contact = findContact(incident.accountId, contactId);
      if (!contact || contact.channels.email !== true) {
        incident.pendingEta.delete(contactId);
        continue;
      }
      sendEtaUpdate(incident, circuit, contact, {
        eta: pending.eta,
        previousEta: pending.previousEta,
        now,
        eventAt: new Date(pending.updatedAt).getTime(),
      });
    }
    if (incident.intermittent && !isFlapping(incident, now)) {
      settleIntermittent(incident, circuit, now);
    }
  }
}

function enterIntermittent(incident, circuit, event, { now, suppressed }) {
  incident.intermittent = true;
  incident.state = 'intermittent';
  addHistory(incident, event.timestamp, 'Circuit is flapping; individual down and restored alerts paused', { state: 'intermittent' });
  return notify(incident, circuit, 'E6', 'intermittent', (_contact, tz) => ({
    ...baseVars(incident, circuit, ACCOUNTS[incident.accountId], tz),
    count: flapCount(incident, now),
    update_history: historyLines(incident, { timeZone: tz }),
  }), {
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
  sweep(now);
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

  // Out-of-order delivery: record it, optionally apply a newer ETA, but never
  // mutate incident state for a stale event.
  if (!isNew && !backfilled && eventAt < incident.lastEventAt) {
    addHistory(
      incident,
      event.timestamp,
      `Late event: reported ${event.state} at ${event.timestamp} (received out of order)`,
      { state: event.state, late: true },
    );
    if (!incident.etaUpdatedAt || event.timestamp > incident.etaUpdatedAt) {
      applyEta(incident, circuit, event, { now, backfilled: true, suppressed });
    }
    return {
      outcome: 'out-of-order',
      incidentId: incident.incidentId,
      notificationsQueued: 0,
      suppressed,
    };
  }
  incident.lastEventAt = Math.max(incident.lastEventAt, eventAt);

  // Impact corrections ride along on any in-order event: an absent field keeps
  // the current value, an explicit null clears it. Applied before any notify
  // call so rendered copy always carries the latest assessment.
  if (!isNew && !backfilled && Object.hasOwn(event, 'impact') && event.impact !== incident.impact) {
    incident.impact = event.impact;
    addHistory(incident, event.timestamp, `Impact updated: ${event.impact === null ? 'none' : event.impact}`);
  }

  let queued = 0;

  // Flapping: resume normal rules after 15 minutes of stable state (D4).
  if (incident.intermittent && !isFlapping(incident, eventAt)) {
    queued += settleIntermittent(incident, circuit, now, suppressed);
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
      queued += notify(incident, circuit, templateId, type,
        (_contact, tz) => baseVars(incident, circuit, ACCOUNTS[incident.accountId], tz),
        {
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
    // Reopened outage on the same incident id: re-alert with a reopen variant
    // so the type-level de-dup does not swallow it.
    incident.closed = false;
    incident.state = event.state;
    incident.reportedState = event.state;
    incident.restoredAt = null;
    addHistory(incident, event.timestamp, `Incident reopened: reported ${event.state}`, { state: event.state, backfilled });
    if (!backfilled) {
      const type = event.state === 'down' ? 'down' : 'degraded';
      const templateId = event.state === 'down' ? 'E1' : 'E2';
      queued += notify(incident, circuit, templateId, type,
        (_contact, tz) => baseVars(incident, circuit, ACCOUNTS[incident.accountId], tz),
        {
          now,
          eventAt,
          variant: `reopen:${incident.history.length}`,
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

  const prev = incident.reportedState;

  if (event.state === 'restored' && !incident.closed) {
    incident.reportedState = 'restored';
    incident.state = 'restored';
    incident.restoredAt = event.timestamp;
    incident.closed = true;
    incident.pendingEta.clear(); // restored cancels any pending ETA update (AC-5)
    addHistory(incident, event.timestamp, `Restored at ${event.timestamp}`, { state: 'restored', backfilled });
    if (!backfilled) {
      queued += notify(incident, circuit, 'E5', 'restored', (_contact, tz) => ({
        ...baseVars(incident, circuit, ACCOUNTS[incident.accountId], tz),
        restored_at: formatTimestamp(event.timestamp, tz),
        duration: fmtDuration(incident.startedAt, event.timestamp),
      }), { now, eventAt, suppressed });
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
      const seq = incident.history.length;
      queued += notify(incident, circuit, 'E3', 'state_change', (_contact, tz) => ({
        ...baseVars(incident, circuit, ACCOUNTS[incident.accountId], tz),
        changed_at: formatTimestamp(event.timestamp, tz),
        previous_state: STATE_WORDS[prev],
        previous_state_raw: prev,
        state: STATE_WORDS[event.state],
        state_raw: event.state,
      }), {
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
  currentIncidentForCircuit,
  getNotificationLog,
  listAccounts,
  applyEvent,
  resetStore,
  formatCopyText,
  sweep,
};
