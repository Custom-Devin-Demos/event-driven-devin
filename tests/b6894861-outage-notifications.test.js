/* global describe, expect, test, beforeEach, beforeAll, afterAll, jest */

jest.mock('../app/telemetry/datadog', () => ({
  tracer: { init: jest.fn() },
  initDatadog: jest.fn(),
  getStatsClient: jest.fn(() => null),
  recordMetric: jest.fn(),
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');
const http = require('http');

const service = require('../app/services/outage-notifications');
const {
  processEvent,
  normalizeEvent,
  ValidationError,
  render,
  getAccountIncidents,
  getIncident,
  getNotificationLog,
  getPreferences,
  setChannel,
  currentIncidentForCircuit,
  optedInContacts,
  resetStore,
  resetQueue,
  resetPreferences,
  resetProcessedEvents,
  gateway,
  formatTimestamp,
  sweep,
} = service;

const CIRCUIT = 'ckt-nwl-001';
const ACCOUNT = 'acct-lumen-1001';
const OPTED_IN = 'contact-1001-a';
const OPTED_OUT = 'contact-1001-b';

let seq = 0;
function event(over = {}, ts = Date.now()) {
  seq += 1;
  return {
    eventId: `evt-test-${seq}`,
    incidentId: over.incidentId || `inc-test-${seq}`,
    circuitId: CIRCUIT,
    state: 'down',
    timestamp: new Date(ts).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  resetStore();
  resetQueue();
  resetPreferences();
  resetProcessedEvents();
  seq = 0;
});

describe('AC-1 down event notifies opted-in contacts', () => {
  test('each opted-in contact gets a down notification queued', () => {
    const now = Date.now();
    const result = processEvent(event({ incidentId: 'inc-a1' }), { now });
    expect(result.outcome).toBe('processed');
    expect(result.notificationsQueued).toBe(1);
    const queued = gateway.queue.filter((q) => q.state === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0].contactId).toBe(OPTED_IN);
    expect(queued[0].channel).toBe('email');
    expect(queued[0].type).toBe('down');
    expect(queued[0].message.subject).toContain('[Down]');
    expect(queued[0].message.subject).toContain('inc-a1');
  });

  test('normalizeEvent rejects malformed events with VALIDATION_ERROR', () => {
    expect(() => normalizeEvent({ eventId: 'x' })).toThrow(ValidationError);
    try {
      normalizeEvent(event({ state: 'wobbly' }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('VALIDATION_ERROR');
    }
    expect(() => normalizeEvent(event({ timestamp: 'not-a-date' }))).toThrow(ValidationError);
    expect(() => normalizeEvent(event({ eta: 'nope' }))).toThrow(ValidationError);
  });
});

describe('AC-2 degraded event is distinct from down', () => {
  test('degraded notification uses E2 copy and [Degraded] subject', () => {
    processEvent(event({ state: 'degraded', incidentId: 'inc-a2' }));
    const q = gateway.queue[0];
    expect(q.type).toBe('degraded');
    expect(q.message.subject).toContain('[Degraded]');
    expect(q.message.text).toContain('This is not a full outage');
    expect(q.message.text).toContain('Status: Degraded');
  });
});

describe('AC-3 restored closes the incident and notifies', () => {
  test('restored sends E5 with the same incident id and resolves the incident', () => {
    const now = Date.now();
    processEvent(event({ incidentId: 'inc-a3' }), { now });
    processEvent(event({ incidentId: 'inc-a3', state: 'restored' }, now + 30 * 60000), { now: now + 30 * 60000 });
    const restored = gateway.queue.find((q) => q.type === 'restored');
    expect(restored).toBeDefined();
    expect(restored.incidentId).toBe('inc-a3');
    expect(restored.message.subject).toContain('[Restored]');
    expect(restored.message.text).toContain('Outage duration: 30 min');
    const incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === 'inc-a3');
    expect(incident.closed).toBe(true);
    expect(incident.state).toBe('restored');
    expect(incident.restoredAt).toBeTruthy();
  });
});

describe('AC-4 repeated same-state events de-duplicate', () => {
  test('second down sends no email and records a Still down history entry', () => {
    const now = Date.now();
    processEvent(event({ incidentId: 'inc-a4' }), { now });
    const result = processEvent(event({ incidentId: 'inc-a4', state: 'down' }, now + 60000), { now: now + 60000 });
    expect(result.notificationsQueued).toBe(0);
    expect(gateway.queue.filter((q) => q.state === 'queued')).toHaveLength(1);
    const incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === 'inc-a4');
    expect(incident.history.some((h) => h.text.startsWith('Still down, confirmed'))).toBe(true);
  });

  test('duplicate eventId is idempotent', () => {
    const e = event({ incidentId: 'inc-a4b' });
    processEvent(e);
    const again = processEvent({ ...e });
    expect(again.outcome).toBe('duplicate-event');
    expect(gateway.queue).toHaveLength(1);
  });

  test('flapping trips a single intermittent notification and holds the rest', () => {
    const now = Date.now();
    const inc = 'inc-flap';
    const states = ['down', 'restored', 'down', 'restored', 'down'];
    states.forEach((s, i) => {
      processEvent(event({ incidentId: inc, state: s }, now + i * 60000), { now: now + i * 60000 });
    });
    const incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.state).toBe('intermittent');
    const intermittent = gateway.queue.filter((q) => q.type === 'intermittent');
    expect(intermittent).toHaveLength(1);
    expect(intermittent[0].message.subject).toContain('[Intermittent]');
  });
});

describe('AC-5 ETA changes batched to one email per 30 minutes', () => {
  test('ETA change adds history and one E4 per window', () => {
    const now = Date.now();
    const inc = 'inc-a5';
    processEvent(event({ incidentId: inc }), { now });
    const eta1 = new Date(now + 2 * 3600e3).toISOString();
    processEvent(event({ incidentId: inc, eta: eta1 }, now + 60000), { now: now + 60000 });
    const eta2 = new Date(now + 3 * 3600e3).toISOString();
    processEvent(event({ incidentId: inc, eta: eta2 }, now + 120000), { now: now + 120000 });
    let incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.history.some((h) => h.text.includes(`ETA updated to ${eta1}`))).toBe(true);
    expect(incident.history.some((h) => h.text.includes(`ETA updated to ${eta2} (was ${eta1})`))).toBe(true);
    const etaEmails = gateway.queue.filter((q) => q.type === 'eta_update' && q.state === 'queued');
    expect(etaEmails).toHaveLength(1); // second change inside 30 min is held
    // After the window, the next ETA change notifies again.
    const eta3 = new Date(now + 4 * 3600e3).toISOString();
    processEvent(event({ incidentId: inc, eta: eta3 }, now + 40 * 60000), { now: now + 40 * 60000 });
    expect(gateway.queue.filter((q) => q.type === 'eta_update' && q.state === 'queued')).toHaveLength(2);
    // ETA withdrawn writes its own history entry.
    processEvent(event({ incidentId: inc, eta: null }, now + 41 * 60000), { now: now + 41 * 60000 });
    incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.history.some((h) => h.text === 'ETA withdrawn, we will update when we have a new estimate')).toBe(true);
  });

  test('degraded to down escalates and sends E3', () => {
    const now = Date.now();
    const inc = 'inc-a5b';
    processEvent(event({ incidentId: inc, state: 'degraded' }), { now });
    processEvent(event({ incidentId: inc, state: 'down' }, now + 60000), { now: now + 60000 });
    const e3 = gateway.queue.find((q) => q.type === 'state_change');
    expect(e3).toBeDefined();
    expect(e3.message.text).toContain('has gone from degraded to down');
  });
});

describe('AC-6 missing ETA is stated, never a placeholder', () => {
  test('E1 text states ETA not yet available', () => {
    processEvent(event({ incidentId: 'inc-a6' }));
    const q = gateway.queue[0];
    expect(q.message.text).toContain('Estimated restore: ETA not yet available.');
    expect(q.message.text).toContain('at most every 30 minutes');
    expect(q.message.text).not.toContain('{eta}');
  });
});

describe('AC-7 non-opted-in contacts receive nothing', () => {
  test('contact with all channels off gets no notification', () => {
    processEvent(event({ incidentId: 'inc-a7' }));
    expect(gateway.queue.every((q) => q.contactId !== OPTED_OUT)).toBe(true);
    expect(optedInContacts(ACCOUNT, 'email').map((c) => c.id)).toEqual([OPTED_IN]);
  });
});

describe('AC-8 preference changes take effect for the next event and are audited', () => {
  test('setChannel enables delivery and writes an audit entry', () => {
    const before = processEvent(event({ incidentId: 'inc-a8a' }));
    expect(before.notificationsQueued).toBe(1);
    const result = setChannel({
      accountId: ACCOUNT,
      contactId: OPTED_OUT,
      channel: 'email',
      enabled: true,
      actor: 'admin-test',
    });
    expect(result.audit).toMatchObject({ contactId: OPTED_OUT, channel: 'email', enabled: true, actor: 'admin-test' });
    expect(result.contact.lastChangedBy).toBe('admin-test');
    const prefs = getPreferences(ACCOUNT);
    expect(prefs.audit).toHaveLength(1);
    const after = processEvent(event({ incidentId: 'inc-a8b' }));
    expect(after.notificationsQueued).toBe(2);
  });
});

describe('AC-9 open incident drives banner and chronological history', () => {
  test('portal payload exposes an open incident with ordered history', () => {
    const now = Date.now();
    const inc = 'inc-a9';
    processEvent(event({ incidentId: inc }), { now });
    processEvent(event({ incidentId: inc, eta: new Date(now + 3600e3).toISOString() }, now + 60000), { now: now + 60000 });
    const incidents = getAccountIncidents(ACCOUNT);
    const i = incidents.find((x) => x.incidentId === inc);
    expect(i.history[0].text).toContain('Incident opened');
    const times = i.history.map((h) => new Date(h.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('AC-10 healthy state is distinct from no circuits', () => {
  test('no incidents means no banner and healthy circuit states', () => {
    expect(getAccountIncidents(ACCOUNT)).toHaveLength(0);
    const { getAccountCircuits } = service;
    expect(getAccountCircuits(ACCOUNT).length).toBeGreaterThan(0);
    expect(getAccountIncidents('acct-lumen-2002')).toHaveLength(0);
  });
});

describe('AC-11 unresolvable circuits are logged, never notified', () => {
  test('unknown circuit returns unresolved-circuit with nothing queued', () => {
    const result = processEvent(event({ circuitId: 'ckt-nope-999' }));
    expect(result.outcome).toBe('unresolved-circuit');
    expect(gateway.queue).toHaveLength(0);
    expect(getAccountIncidents(ACCOUNT)).toHaveLength(0);
  });
});

describe('AC-12 notification log per incident for support agents', () => {
  test('log entries carry channel, contact, type and state', () => {
    processEvent(event({ incidentId: 'inc-a12' }));
    const log = getNotificationLog('inc-a12');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ contactId: OPTED_IN, channel: 'email', type: 'down', state: 'queued' });
  });
});

describe('AC-13 plain-text fallback matches HTML copy', () => {
  test('render returns text and html carrying identical lines', () => {
    const message = render('E1', {
      circuit_id: CIRCUIT,
      circuit_name: 'TEST-CIRCUIT',
      site_a: 'A',
      site_z: 'Z',
      account_name: 'Northwind Logistics',
      incident_id: 'inc-a13',
      started_at: '2026-09-14T09:42:00Z',
      eta: null,
      portal_url: '/lumen',
      prefs_url: '/lumen#notifications',
      support_phone: '1-877-453-8353',
    });
    expect(message.subject).toBe('[Down] TEST-CIRCUIT (ckt-nwl-001) - Lumen incident inc-a13');
    expect(message.text).toContain('ETA not yet available');
    for (const line of message.text.split('\n')) {
      expect(message.html).toContain(line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    }
    expect(message.html).toContain('View live status');
    expect(message.html).toContain('role="presentation"');
  });

  test('formatTimestamp renders contact-timezone copy', () => {
    expect(formatTimestamp('2026-09-14T16:42:00.000Z', 'America/Los_Angeles'))
      .toBe('14 Sep 2026, 09:42 PDT');
    expect(formatTimestamp(null)).toBe('');
  });

  test('queued emails carry the contact-timezone timestamps', () => {
    const ts = Date.UTC(2026, 8, 14, 16, 42, 0);
    processEvent(event({ incidentId: 'inc-a13b' }, ts), { now: ts });
    const q = gateway.queue[0];
    expect(q.message.text).toContain('Detected 14 Sep 2026, 09:42 PDT.');
  });
});

describe('AC-14 replayed events backfill portal state without fresh email', () => {
  test('event older than 60 minutes updates state and sends no notification', () => {
    const now = Date.now();
    processEvent(event({ incidentId: 'inc-a14' }), { now });
    const queuedBefore = gateway.queue.length;
    const result = processEvent(
      event({ incidentId: 'inc-a14', state: 'down' }, now - 75 * 60000),
      { now },
    );
    expect(result.outcome).toBe('backfilled');
    expect(gateway.queue.length).toBe(queuedBefore);
    const incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === 'inc-a14');
    expect(incident.history.some((h) => h.backfilled && h.text.endsWith('(backfilled)'))).toBe(true);
  });

  test('maintenance events create no incident and no notification', () => {
    const result = processEvent(event({ maintenance: true, incidentId: 'inc-maint' }));
    expect(result.outcome).toBe('maintenance-ignored');
    expect(gateway.queue).toHaveLength(0);
    expect(getAccountIncidents(ACCOUNT)).toHaveLength(0);
  });
});

describe('integration', () => {
  let server;
  let baseUrl;

  function req(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const request = http.request(`${baseUrl}${urlPath}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      });
      request.on('error', reject);
      if (body) request.write(JSON.stringify(body));
      request.end();
    });
  }

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(require('../app/routes/verticals/b6894861'));
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  test('POST events then both circuit-incidents paths return the incident', async () => {
    const post = await req('POST', '/api/b6894861/noc/events', {
      events: [event({ incidentId: 'inc-int-1' })],
    });
    expect(post.status).toBe(200);
    expect(post.body.accepted).toBe(1);
    expect(post.body.results[0].outcome).toBe('processed');

    for (const p of ['/accounts/acct-lumen-1001/circuit-incidents', '/api/b6894861/accounts/acct-lumen-1001/circuit-incidents']) {
      const res = await req('GET', p);
      expect(res.status).toBe(200);
      expect(res.body.accountId).toBe(ACCOUNT);
      expect(res.body.openCount).toBe(1);
      expect(res.body.banner.variant).toBe('single');
      expect(res.body.banner.text).toContain('Down:');
      const inc = res.body.incidents.find((i) => i.incidentId === 'inc-int-1');
      expect(inc.state).toBe('down');
      expect(inc.etaLabel).toBe('ETA not yet available');
      expect(inc.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(inc.startedAtLabel).toMatch(/\d{4}, \d{2}:\d{2} [A-Z]{2,5}$/);
      expect(inc.history[0].text).toContain('Incident opened');
      expect(inc.history[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(inc.history[0].atLabel).toMatch(/\d{4}, \d{2}:\d{2} [A-Z]{2,5}$/);
      const circuit = res.body.circuits.find((c) => c.circuitId === CIRCUIT);
      expect(circuit.state).toBe('down');
      expect(circuit.currentIncidentId).toBe('inc-int-1');
    }
  });

  test('AC-14 strict timestamps: date-only is a 400, a +02:00 offset is accepted', async () => {
    const bad = await req('POST', '/api/b6894861/noc/events', {
      events: [event({ incidentId: 'inc-ts-bad', timestamp: '2026-09-15' })],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');

    const good = await req('POST', '/api/b6894861/noc/events', {
      events: [event({
        incidentId: 'inc-ts-ok',
        // Same instant as now, rendered with a +02:00 zone offset.
        timestamp: new Date(Date.now() + 2 * 3600e3).toISOString().replace('Z', '+02:00'),
      })],
    });
    expect(good.status).toBe(200);
    expect(good.body.results[0].outcome).toBe('processed');

    const badEta = await req('POST', '/api/b6894861/noc/events', {
      events: [event({ incidentId: 'inc-eta-bad', eta: '2026-09-15 04:00' })],
    });
    expect(badEta.status).toBe(400);
  });

  test('validation failure is a 400 and partially applies nothing', async () => {
    const res = await req('POST', '/api/b6894861/noc/events', {
      events: [{ eventId: 'bad-1', incidentId: 'x', circuitId: CIRCUIT, state: 'sideways', timestamp: '2026-01-01T00:00:00Z' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('unknown account 404s; preferences GET/PUT round-trip; notifications endpoint', async () => {
    expect((await req('GET', '/accounts/acct-nope/circuit-incidents')).status).toBe(404);

    const prefs = await req('GET', `/api/b6894861/accounts/${ACCOUNT}/preferences`);
    expect(prefs.status).toBe(200);
    expect(prefs.body.contacts.length).toBeGreaterThanOrEqual(2);

    const put = await req('PUT', `/api/b6894861/accounts/${ACCOUNT}/preferences`, {
      contactId: OPTED_OUT, channel: 'email', enabled: true, actor: 'it-admin',
    });
    expect(put.status).toBe(200);
    expect(put.body.audit.actor).toBe('it-admin');

    await req('POST', '/api/b6894861/noc/events', { events: [event({ incidentId: 'inc-int-2' })] });
    const notifs = await req('GET', `/api/b6894861/accounts/${ACCOUNT}/incidents/inc-int-2/notifications`);
    expect(notifs.status).toBe(200);
    expect(notifs.body.notifications.length).toBeGreaterThan(0);

    const reset = await req('POST', '/api/b6894861/demo/reset');
    expect(reset.status).toBe(200);
    const after = await req('GET', `/api/b6894861/accounts/${ACCOUNT}/circuit-incidents`);
    expect(after.body.banner).toBeNull();
    expect(after.body.openCount).toBe(0);
    expect(after.body.circuits.every((c) => c.state === 'healthy')).toBe(true);
  });
});

describe('Review fixes', () => {
  test('AC-5 held ETA update flushes via sweep once the rolling window expires', () => {
    const t0 = Date.now();
    const inc = 'inc-eta-flush';
    const etaA = new Date(t0 + 3600e3).toISOString();
    const etaB = new Date(t0 + 2 * 3600e3).toISOString();
    processEvent(event({ incidentId: inc }), { now: t0 });
    processEvent(event({ incidentId: inc, eta: etaA }, t0 + 60000), { now: t0 + 60000 });
    expect(gateway.queue.filter((q) => q.type === 'eta_update')).toHaveLength(1);
    processEvent(event({ incidentId: inc, eta: etaB }, t0 + 5 * 60000), { now: t0 + 5 * 60000 });
    // Held inside the rolling 30-minute window — still only the first E4.
    expect(gateway.queue.filter((q) => q.type === 'eta_update')).toHaveLength(1);
    sweep(t0 + 31 * 60000);
    const etaMails = gateway.queue.filter((q) => q.type === 'eta_update');
    expect(etaMails).toHaveLength(2);
    expect(etaMails[1].message.text).toContain(`New estimate: ${formatTimestamp(etaB)}`);
    expect(etaMails[1].message.text).toContain(`Previous estimate: ${formatTimestamp(etaA)}`);
    sweep(t0 + 32 * 60000);
    expect(gateway.queue.filter((q) => q.type === 'eta_update')).toHaveLength(2);
  });

  test('AC-3 out-of-order event records a late history entry without reopening', () => {
    const t0 = Date.now();
    const inc = 'inc-late';
    processEvent(event({ incidentId: inc }), { now: t0 });
    processEvent(event({ incidentId: inc, state: 'restored' }, t0 + 10 * 60000), { now: t0 + 10 * 60000 });
    const queuedBefore = gateway.queue.filter((q) => q.state === 'queued').length;
    const result = processEvent(
      event({ incidentId: inc, state: 'down' }, t0 + 5 * 60000),
      { now: t0 + 10 * 60000 },
    );
    expect(result.outcome).toBe('out-of-order');
    expect(result.notificationsQueued).toBe(0);
    expect(gateway.queue.filter((q) => q.state === 'queued')).toHaveLength(queuedBefore);
    const incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.closed).toBe(true);
    expect(incident.state).toBe('restored');
    expect(incident.history.some((h) => h.late && h.text.startsWith('Late event: reported down'))).toBe(true);
  });

  test('AC-3 reopened outage on the same incident re-alerts', () => {
    const t0 = Date.now();
    const inc = 'inc-reopen';
    processEvent(event({ incidentId: inc }), { now: t0 });
    processEvent(event({ incidentId: inc, state: 'restored' }, t0 + 10 * 60000), { now: t0 + 10 * 60000 });
    processEvent(event({ incidentId: inc, state: 'down' }, t0 + 20 * 60000), { now: t0 + 20 * 60000 });
    const downs = gateway.queue.filter((q) => q.type === 'down' && q.contactId === OPTED_IN);
    expect(downs).toHaveLength(2);
    const incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.closed).toBe(false);
    expect(incident.state).toBe('down');
    expect(incident.history.some((h) => h.text === 'Incident reopened: reported down')).toBe(true);
  });

  test('AC-3 reopen resets the stale ETA: reopen alert carries only the new estimate', () => {
    const t0 = Date.now();
    const inc = 'inc-reopen-eta';
    const etaA = new Date(t0 + 3600e3).toISOString(); // ~14:00 segment
    const etaB = new Date(t0 + 4 * 3600e3).toISOString(); // ~17:00 segment
    processEvent(event({ incidentId: inc, eta: etaA }), { now: t0 });
    processEvent(event({ incidentId: inc, state: 'restored' }, t0 + 10 * 60000), { now: t0 + 10 * 60000 });
    const queuedBefore = gateway.queue.filter((q) => q.state === 'queued').length;
    processEvent(event({ incidentId: inc, state: 'down', eta: etaB }, t0 + 20 * 60000), { now: t0 + 20 * 60000 });

    const fresh = gateway.queue.filter((q) => q.state === 'queued').slice(queuedBefore);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].type).toBe('down');
    expect(fresh[0].message.subject).toContain('[Down]');
    expect(fresh[0].message.text).toContain(formatTimestamp(etaB));
    expect(fresh[0].message.text).not.toContain(formatTimestamp(etaA));
    expect(getNotificationLog(inc).filter((n) => n.type === 'eta_update')).toHaveLength(0);
    expect(getIncident(inc).eta).toBe(etaB);

    // Reopen without an eta clears the estimate entirely.
    processEvent(event({ incidentId: inc, state: 'restored' }, t0 + 30 * 60000), { now: t0 + 30 * 60000 });
    const queuedBefore2 = gateway.queue.filter((q) => q.state === 'queued').length;
    processEvent(event({ incidentId: inc, state: 'down' }, t0 + 40 * 60000), { now: t0 + 40 * 60000 });
    expect(getIncident(inc).eta).toBeNull();
    const reopen2 = gateway.queue.filter((q) => q.state === 'queued').slice(queuedBefore2)
      .find((q) => q.type === 'down');
    expect(reopen2.message.text).toContain('ETA not yet available');
  });

  test('AC-4 intermittent incident resolves via sweep after a stable restore', () => {
    const t0 = Date.now();
    const inc = 'inc-flap-settle';
    ['down', 'restored', 'down', 'restored'].forEach((s, i) => {
      processEvent(event({ incidentId: inc, state: s }, t0 + i * 60000), { now: t0 + i * 60000 });
    });
    let incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.intermittent).toBe(true);
    expect(gateway.queue.filter((q) => q.type === 'intermittent')).toHaveLength(1);
    sweep(t0 + 20 * 60000);
    incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.intermittent).toBe(false);
    expect(incident.closed).toBe(true);
    expect(incident.state).toBe('restored');
    expect(incident.history.some((h) => h.text === 'Circuit stable for 15 minutes; incident resolved')).toBe(true);
    const restoredMails = gateway.queue.filter((q) => q.type === 'restored');
    expect(restoredMails.length).toBeGreaterThanOrEqual(1);
    sweep(t0 + 21 * 60000);
    expect(gateway.queue.filter((q) => q.type === 'restored')).toHaveLength(restoredMails.length);
  });

  test('AC-5 a withdrawn ETA cancels the held update', () => {
    const t0 = Date.now();
    const inc = 'inc-eta-withdraw';
    const etaA = new Date(t0 + 3600e3).toISOString();
    const etaB = new Date(t0 + 2 * 3600e3).toISOString();
    processEvent(event({ incidentId: inc }), { now: t0 });
    processEvent(event({ incidentId: inc, eta: etaA }, t0 + 60000), { now: t0 + 60000 });
    processEvent(event({ incidentId: inc, eta: etaB }, t0 + 5 * 60000), { now: t0 + 5 * 60000 });
    expect(gateway.queue.filter((q) => q.type === 'eta_update')).toHaveLength(1);
    processEvent(event({ incidentId: inc, eta: null }, t0 + 10 * 60000), { now: t0 + 10 * 60000 });
    sweep(t0 + 31 * 60000);
    const etaUpdates = getNotificationLog(inc).filter((n) => n.type === 'eta_update');
    expect(etaUpdates).toHaveLength(1);
    const incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.eta).toBeNull();
    expect(incident.history.some((h) => h.text.startsWith('ETA withdrawn'))).toBe(true);
  });

  test('AC-9 impact updates on a repeat event feed later notifications', () => {
    const t0 = Date.now();
    const inc = 'inc-impact';
    processEvent(event({ incidentId: inc, impact: 'Unknown' }), { now: t0 });
    // Same state -> de-duped, but the impact correction still lands.
    processEvent(event({ incidentId: inc, impact: 'All traffic blocked' }, t0 + 5 * 60000), { now: t0 + 5 * 60000 });
    const incident = getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc);
    expect(incident.impact).toBe('All traffic blocked');
    expect(incident.history.some((h) => h.text === 'Impact updated: All traffic blocked')).toBe(true);
    processEvent(event({ incidentId: inc, state: 'restored' }, t0 + 10 * 60000), { now: t0 + 10 * 60000 });
    const restored = gateway.queue.find((q) => q.type === 'restored');
    expect(restored.message.text).toContain('All traffic blocked');
    // An absent impact field preserves the current value.
    processEvent(event({ incidentId: inc, state: 'down' }, t0 + 20 * 60000), { now: t0 + 20 * 60000 });
    expect(getAccountIncidents(ACCOUNT).find((i) => i.incidentId === inc).impact).toBe('All traffic blocked');
  });

  test('AC-13 email links are absolute when PUBLIC_BASE_URL is set', () => {
    process.env.PUBLIC_BASE_URL = 'https://status.example.com';
    try {
      jest.isolateModules(() => {
        const isoRules = require('../app/services/outage-notifications/rules');
        const isoDelivery = require('../app/services/outage-notifications/delivery');
        isoRules.applyEvent(event({ incidentId: 'inc-abs-links' }));
        const mail = isoDelivery.gateway.queue.find((q) => q.type === 'down');
        expect(mail.message.text).toContain('https://status.example.com/lumen');
        expect(mail.message.html).toContain('https://status.example.com/lumen');
      });
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  test('currentIncidentForCircuit returns the latest open incident on a circuit', () => {
    const t0 = Date.now();
    processEvent(event({ incidentId: 'inc-multi-old', state: 'degraded' }, t0), { now: t0 });
    processEvent(event({ incidentId: 'inc-multi-new', state: 'down' }, t0 + 60000), { now: t0 + 60000 });
    const current = currentIncidentForCircuit(ACCOUNT, CIRCUIT);
    expect(current.incidentId).toBe('inc-multi-new');
    expect(current.state).toBe('down');
    expect(currentIncidentForCircuit(ACCOUNT, 'ckt-nwl-002')).toBeNull();
  });
});

describe('load: time-to-notify', () => {
  test('500 down events process with p95 well under 5 minutes', () => {
    const latencies = [];
    const circuits = ['ckt-nwl-001', 'ckt-nwl-002', 'ckt-nwl-003', 'ckt-cto-001', 'ckt-cto-002'];
    const now = Date.now();
    for (let i = 0; i < 500; i += 1) {
      const e = event({ incidentId: `inc-load-${i}`, circuitId: circuits[i % circuits.length] }, now);
      const start = process.hrtime.bigint();
      processEvent(e, { now });
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      latencies.push(elapsedMs);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95) - 1];
    expect(p95).toBeLessThan(5 * 60 * 1000);
    expect(p95).toBeLessThan(2000);
    expect(gateway.queue.length).toBe(500);
  });
});
