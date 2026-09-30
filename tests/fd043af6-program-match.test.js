/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/fd043af6');
const {
  matchPrograms,
  selectRecommendation,
  FOCUS_AREAS,
  NETWORKS,
  CATALOG_QUERY_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/fd043af6');

const ORIGINAL_LATENCY = [...CATALOG_QUERY_POLICY.latencyMs];
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
  CATALOG_QUERY_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Strategic Education program match', () => {
  test('returns a default match across all SEI institutions with a recommendation', async () => {
    CATALOG_QUERY_POLICY.latencyMs = [1, 3];
    LATENCY_SLO.budgetMs = 3000;

    const result = await matchPrograms();

    expect(result.success).toBe(true);
    expect(result.matchId).toMatch(/^SEI-[0-9A-F]{8}$/);
    expect(result.company).toBe('Acme Logistics');
    expect(result.teamSize).toBe(250);
    expect(result.focusArea).toEqual({
      key: 'business',
      label: 'Business & Leadership',
    });
    expect(result.network).toEqual({
      key: 'all',
      label: 'All SEI institutions (recommended)',
    });
    expect(result.institutionsSearched).toBe(13);
    expect(result.matches.map((match) => match.institutionKey))
      .toEqual(result.matches.map((match) => match.institutionKey).sort(
        (a, b) => NETWORKS.all.institutions.indexOf(a) - NETWORKS.all.institutions.indexOf(b),
      ));
    for (const match of result.matches) {
      expect(match.programs.length).toBeGreaterThan(0);
    }
    expect(result.totalPrograms).toBe(
      result.matches.reduce((total, match) => total + match.programs.length, 0),
    );
    const lowestTuition = Math.min(
      ...result.matches.flatMap((match) => match.programs.map((p) => p.annualTuitionUsd)),
    );
    expect(result.recommendation.annualTuitionUsd).toBe(lowestTuition);
    expect(result.estimatedEligibleLearners).toBe(30);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('covers every focus area with matches from at least five institutions', async () => {
    CATALOG_QUERY_POLICY.latencyMs = [1, 3];

    for (const focusArea of Object.keys(FOCUS_AREAS)) {
      const result = await matchPrograms({ focusArea });
      expect(result.institutionsSearched).toBe(13);
      expect(result.matches.length).toBeGreaterThanOrEqual(5);
      expect(result.recommendation).not.toBeNull();
    }
  });

  test('breaks recommendation tuition ties by earliest institution order', () => {
    const matches = [
      {
        institutionKey: 'first',
        institution: 'First University',
        programs: [
          { program: 'Program A', credential: "Bachelor's", format: 'Online', annualTuitionUsd: 5000 },
        ],
      },
      {
        institutionKey: 'second',
        institution: 'Second University',
        programs: [
          { program: 'Program B', credential: "Bachelor's", format: 'Online', annualTuitionUsd: 5000 },
        ],
      },
    ];

    const recommendation = selectRecommendation(matches);
    expect(recommendation.institutionKey).toBe('first');
    expect(recommendation.program).toBe('Program A');
    expect(selectRecommendation([])).toBeNull();
  });

  test.each(['strayer', 'capella', 'sophia', 'hackbright'])(
    'searches a single institution for the %s network',
    async (network) => {
      CATALOG_QUERY_POLICY.latencyMs = [1, 3];

      const { status, body } = await request('POST', '/api/fd043af6/program-match', {
        network,
        focusArea: network === 'hackbright' ? 'technology' : 'business',
      });
      await tick();

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.institutionsSearched).toBe(1);
      expect(body.network.key).toBe(network);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    },
  );

  test('returns catalog metadata', async () => {
    const { status, body } = await request('GET', '/api/fd043af6/catalog');

    expect(status).toBe(200);
    expect(body.focusAreas).toEqual(Object.entries(FOCUS_AREAS).map(([key, label]) => ({
      key,
      label,
    })));
    expect(body.networks).toEqual(Object.entries(NETWORKS).map(([key, network]) => ({
      key,
      label: network.label,
      institutionCount: network.institutions.length,
    })));
  });

  test('rejects invalid match details through the route', async () => {
    const invalidRequests = [
      { email: 'not-an-email' },
      { teamSize: 0 },
      { focusArea: 'underwater-basket-weaving' },
      { network: 'ivy-league' },
      { company: '   ' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request(
        'POST',
        '/api/fd043af6/program-match',
        body,
      );
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('PROGRAM_MATCH_INVALID');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    CATALOG_QUERY_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 0;

    const { status, body } = await request('POST', '/api/fd043af6/program-match', {
      network: 'strayer',
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
    expect(alert.customer).toBe('fd043af6');
    expect(alert.service).toBe('customer-fd043af6-program-match');
    expect(alert.culprit).toBe('app/services/verticals/fd043af6.js — collectCatalogMatches');
    expect(alert.verticalLabel).toBe('Strategic Education Program Match');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/fd043af6/program-match' },
      { key: 'service', value: 'customer-fd043af6-program-match' },
      { key: 'focus_area', value: 'business' },
      { key: 'network', value: 'strayer' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.matchId,
      durationMs: body.durationMs,
      budgetMs: 0,
      institutionsSearched: 1,
    }));
  });

  test('does not alert when the match completes under budget', async () => {
    CATALOG_QUERY_POLICY.latencyMs = [1, 3];
    LATENCY_SLO.budgetMs = 3000;

    const result = await matchPrograms({ network: 'strayer' });
    await tick();

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeLessThanOrEqual(LATENCY_SLO.budgetMs);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
