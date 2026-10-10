/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/924f5ec9');
const {
  lookupMember,
  LEDGERS,
  ALL_LEDGERS,
  SCOPE_OPTIONS,
  MEMBERS,
  LEDGER_FETCH_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/924f5ec9');

const ORIGINAL_LATENCY = [...LEDGER_FETCH_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  LEDGER_FETCH_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Sharetec member lookup', () => {
  test('loads every ledger in order for the default "All accounts & relationships" scope', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 3];

    const result = await lookupMember({});

    expect(result.success).toBe(true);
    expect(result.lookupId).toMatch(/^SHR-[0-9A-F]{8}$/);
    expect(result.scope).toEqual({ key: 'all', label: 'All accounts & relationships' });
    expect(result.ledgersLoaded).toBe(14);
    expect(result.ledgers.map((l) => l.key)).toEqual(ALL_LEDGERS);

    for (const l of result.ledgers) {
      expect(l.label).toBe(LEDGERS[l.key].label);
      expect(l.system).toBe(LEDGERS[l.key].system);
      expect(l.itemCount).toBe(l.items.length);
    }

    const { member } = result;
    expect(member.memberNumber).toBe('41000');
    expect(member.name).toBe('Sandra Dee');
    expect(member.address).toEqual({
      line1: '123 Main St',
      city: 'Lino Lakes',
      state: 'MN',
      zip: '55014',
    });
    expect(member.ssnLast4).toBe('6151');
    expect(member.dob).toBe('1980-01-01');
    expect(member.idLast4).toBe('789');

    const { summary } = result;
    const fixture = MEMBERS['41000'].ledgers;
    const expectedShares = [...fixture.shares, ...fixture.certificates, ...fixture.ira]
      .reduce((sum, item) => sum + item.balanceCents, 0);
    expect(summary.ledgersLoaded).toBe(14);
    expect(summary.totalSharesCents).toBe(expectedShares);
    expect(summary.totalLoansCents).toBe(fixture.loans[0].currentBalanceCents);
    expect(summary.totalCardsCents).toBe(fixture.credit_cards[0].balanceCents);
    expect(summary.relationshipCount).toBe(fixture.relationships.length);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns fixture items for every ledger of the primary member', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 2];

    const result = await lookupMember({ memberNumber: '41000' });
    const fixture = MEMBERS['41000'].ledgers;

    for (const l of result.ledgers) {
      expect(l.items).toEqual(fixture[l.key]);
      expect(l.items).not.toBe(fixture[l.key]);
    }
  });

  test.each(['shares', 'loans', 'credit_cards', 'relationships'])('loads a single ledger for scope %p', async (scope) => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/924f5ec9/member-lookup', {
      memberNumber: '41000',
      scope,
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ key: scope, label: LEDGERS[scope].label });
    expect(body.ledgersLoaded).toBe(1);
    expect(body.ledgers.map((l) => l.key)).toEqual([scope]);
    expect(body.summary.ledgersLoaded).toBe(1);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('single-ledger results match the same ledger in the full lookup', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 2];

    const full = await lookupMember({ memberNumber: '41000' });
    const single = await lookupMember({ memberNumber: '41000', scope: 'fraud_history' });

    expect(single.ledgers[0]).toEqual(full.ledgers.find((l) => l.key === 'fraud_history'));
  });

  test('looks up the other fixture members', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 2];

    const marcus = await lookupMember({ memberNumber: '41022', scope: 'shares' });
    expect(marcus.member.name).toBe('Marcus Webb');
    expect(marcus.ledgers[0].itemCount).toBe(2);

    const priya = await lookupMember({ memberNumber: '41057', scope: 'safe_deposit' });
    expect(priya.member.name).toBe('Priya Raman');
    expect(priya.ledgers[0].itemCount).toBe(1);
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/924f5ec9/member-lookup', {
      memberNumber: '41000',
      scope: 'loans',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      devinEmail: 'jordan.lee@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.durationMs).toBeGreaterThan(LATENCY_SLO.budgetMs);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.issueTitle).toContain('POST /api/924f5ec9/member-lookup took');
    expect(alert.customer).toBe('924f5ec9');
    expect(alert.service).toBe('customer-924f5ec9-member-lookup');
    expect(alert.culprit).toBe('app/services/verticals/924f5ec9.js — loadMemberLedgers');
    expect(alert.verticalLabel).toBe('Sharetec Velocity Member Lookup');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.promptAppendix).toContain('loadMemberLedgers');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/924f5ec9/member-lookup' },
      { key: 'service', value: 'customer-924f5ec9-member-lookup' },
      { key: 'scope', value: 'loans' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.lookupId,
      durationMs: body.durationMs,
      budgetMs: 1,
      ledgersLoaded: 1,
    }));
  });

  test('rejects invalid lookup requests through the route', async () => {
    const invalidRequests = [
      { memberNumber: 'abc' },
      { memberNumber: '12' },
      { memberNumber: '1'.repeat(11) },
      { memberNumber: '41000', scope: 'not-a-ledger' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request(
        'POST',
        '/api/924f5ec9/member-lookup',
        body,
      );
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('MEMBER_LOOKUP_INVALID');
      expect(response).toHaveProperty('requestId');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns 404 for a well-formed but unknown member number', async () => {
    const { status, body } = await request('POST', '/api/924f5ec9/member-lookup', {
      memberNumber: '999999',
    });

    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('MemberNotFoundError');
    expect(body.code).toBe('MEMBER_NOT_FOUND');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns ledger, scope, and member metadata', async () => {
    const { status, body } = await request('GET', '/api/924f5ec9/ledgers');

    expect(status).toBe(200);
    expect(body.ledgers.map((l) => l.key)).toEqual(ALL_LEDGERS);
    expect(body.scopeOptions[0]).toEqual({ key: 'all', label: 'All accounts & relationships', ledgerCount: 14 });
    expect(body.scopeOptions).toHaveLength(Object.keys(SCOPE_OPTIONS).length);
    expect(body.members).toEqual(expect.arrayContaining([
      { memberNumber: '41000', name: 'Sandra Dee' },
      { memberNumber: '41022', name: 'Marcus Webb' },
      { memberNumber: '41057', name: 'Priya Raman' },
    ]));
  });
});
