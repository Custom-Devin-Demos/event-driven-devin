/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const routes = require('../app/routes/verticals/37b90289');
const {
  searchCases,
  COURTS,
  NATIONWIDE_COURTS,
  COURT_SCOPES,
  CHAPTERS,
  DOCKET_QUERY_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/37b90289');

const ORIGINAL_LATENCY = [...DOCKET_QUERY_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'epiq-test-request';
    next();
  });
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
  DOCKET_QUERY_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('Epiq AACER case search', () => {
  test('returns nationwide cases and summaries in AACER priority order', async () => {
    DOCKET_QUERY_POLICY.latencyMs = [1, 2];
    LATENCY_SLO.budgetMs = 3000;

    const result = await searchCases({ debtorName: 'Red Lobster' });
    const courtOrder = new Map(NATIONWIDE_COURTS.map((court, index) => [court, index]));

    expect(result.success).toBe(true);
    expect(result.searchId).toMatch(/^EPIQ-[0-9A-F]{8}$/);
    expect(result.debtorName).toBe('Red Lobster');
    expect(result.courtScope).toEqual({
      key: 'nationwide',
      label: 'All Courts — Nationwide (AACER)',
    });
    expect(result.chapter).toEqual({ key: 'all', label: 'All Chapters' });
    expect(result.courtsQueried).toBe(14);
    expect(result.courtSummaries.map((summary) => summary.court)).toEqual(NATIONWIDE_COURTS);
    expect(result.results.map((match) => courtOrder.get(match.court))).toEqual(
      [...result.results.map((match) => courtOrder.get(match.court))].sort((a, b) => a - b),
    );
    expect(result.totalMatches).toBe(result.results.length);
    expect(result.courtSummaries.map((summary) => summary.matchCount)).toEqual(
      NATIONWIDE_COURTS.map((court) => result.results.filter((match) => match.court === court).length),
    );
    const nationwideSearches = [result];
    for (const debtorName of ['Tupperware Brands', 'WeWork']) {
      nationwideSearches.push(await searchCases({ debtorName }));
    }
    for (const nationwide of nationwideSearches) {
      for (const match of nationwide.results) {
        expect(match.caseNumber.slice(0, 2)).toBe(match.filedDate.slice(2, 4));
        expect(match.filedDate <= '2026-09-30').toBe(true);
      }
    }
    for (const court of NATIONWIDE_COURTS) {
      const courtCases = result.results.filter((match) => match.court === court);
      expect(new Set(courtCases.map((match) => match.caseNumber)).size).toBe(courtCases.length);
    }
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        court: expect.any(String),
        courtLabel: expect.any(String),
        caseNumber: expect.stringMatching(/^\d{2}-\d{5}$/),
        debtor: expect.stringMatching(/^Red Lobster /),
        chapter: expect.stringMatching(/^(7|11|13)$/),
        filedDate: expect.stringMatching(/^202[4-6]-\d{2}-\d{2}$/),
        status: expect.stringMatching(/^(Open|Plan Confirmed|Claims Bar Date Set|Closed)$/),
        claimsAgent: expect.any(String),
      }),
    ]));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns the same DEDE cases from the direct and nationwide scopes', async () => {
    DOCKET_QUERY_POLICY.latencyMs = [1, 2];

    const nationwide = await searchCases({ debtorName: 'Acme Holdings' });
    const delaware = await searchCases({ debtorName: 'Acme Holdings', courtScope: 'dede' });

    expect(delaware.courtsQueried).toBe(1);
    expect(delaware.courtSummaries).toEqual([{
      court: 'DEDE',
      courtLabel: COURTS.DEDE.label,
      matchCount: delaware.results.length,
    }]);
    expect(delaware.results).toEqual(nationwide.results.filter((match) => match.court === 'DEDE'));
  });

  test('filters by chapter and assigns Epiq as the Chapter 11 claims agent', async () => {
    DOCKET_QUERY_POLICY.latencyMs = [1, 2];
    let debtorName = 'Red Lobster';
    let allChapters = await searchCases({ debtorName });

    for (let attempt = 1; attempt <= 20 && !allChapters.results.some((match) => match.chapter === '11'); attempt += 1) {
      debtorName = `Red Lobster ${attempt}`;
      allChapters = await searchCases({ debtorName });
    }

    expect(allChapters.results.some((match) => match.chapter === '11')).toBe(true);
    const chapterEleven = await searchCases({ debtorName, chapter: '11' });

    expect(chapterEleven.chapter).toEqual({ key: '11', label: 'Chapter 11' });
    expect(chapterEleven.results.length).toBeGreaterThan(0);
    expect(chapterEleven.results).toEqual(allChapters.results.filter((match) => match.chapter === '11'));
    expect(chapterEleven.results.every((match) => (
      match.chapter === '11' && match.claimsAgent === 'Epiq Corporate Restructuring'
    ))).toBe(true);
  });

  test('rejects invalid search details through the route', async () => {
    const invalidRequests = [
      { debtorName: '' },
      { debtorName: 'Red Lobster', courtScope: 'unknown' },
      { debtorName: 'Red Lobster', chapter: '9' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request(
        'POST',
        '/api/37b90289/case-search',
        body,
      );
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('CASE_SEARCH_INVALID');
      expect(response.requestId).toBe('epiq-test-request');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns search metadata for court scopes and chapters', async () => {
    const { status, body } = await request('GET', '/api/37b90289/courts');

    expect(status).toBe(200);
    expect(body.scopes).toEqual(Object.entries(COURT_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      courtCount: scope.courts.length,
    })));
    expect(body.chapters).toEqual(Object.entries(CHAPTERS).map(([key, label]) => ({ key, label })));
  });

  test('schedules a latency-budget alert with the remediation directive on breach', async () => {
    DOCKET_QUERY_POLICY.latencyMs = [1, 2];
    LATENCY_SLO.budgetMs = -1;

    const result = await searchCases({
      debtorName: 'Red Lobster',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      devinEmail: 'jordan.lee@example.com',
    });
    await tick();

    expect(result.success).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.culprit).toContain('collectCourtDockets');
    expect(alert.customer).toBe('37b90289');
    expect(alert.slackMemberId).toBe('');
    expect(alert.slackMemberIdFallback).toBe(process.env.EPIQ_SLACK_MEMBER_ID || '');
    expect(alert.promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'duration_ms', value: String(result.durationMs) },
      { key: 'court_scope', value: 'nationwide' },
      { key: 'chapter', value: 'all' },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: result.searchId,
      durationMs: result.durationMs,
      budgetMs: -1,
      courtsQueried: 14,
    }));
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LatencyBudgetExceeded' }),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ alert_path: 'latency' }),
      }),
    );
  });
});
