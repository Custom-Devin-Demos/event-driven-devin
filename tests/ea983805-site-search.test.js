/* global afterEach, beforeEach, describe, expect, jest, test, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: {} })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { resetLatencyAlertCooldowns } = require('../app/services/latency-alert-cooldown');
const routes = require('../app/routes/verticals/ea983805');
const {
  SCOPES,
  CONTENT_INDEXES,
  INDEX_QUERY_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/ea983805');

const ORIGINAL_LATENCY = [...INDEX_QUERY_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const REQUEST_ID = /^CER-SRCH-[0-9A-F]{6}$/;

const VOICE_TOP_TEN = [
  'Voice UX for Self-Driving Cars – Adam Emfield, Cerence – Voice Tech Podcast ep.046',
  'Voice Interaction + Large Model, When will more Human-like In-Car Voice Interaction Come?',
  'Voice Year in Review 2021 The Enterprise Edition – Voicebot Podcast Ep 239',
  'Voice Assistant Adoption in the Car Data Review with Cerence CEO Sanjay Dhawan – Voicebot Podcast Ep 144',
  'Voice Assistants Help Truckers Take Hassle out of Record-Keeping',
  'Voice is Just The Beginning – How Cerence is Creating The In-Car Assistants of The Future',
  'Voice AI Takes the Wheel Transforming Connected Car Experiences',
  'Voice is the New Infrastructure',
  'Diversity in Voice Assistants: Adjusting Tone and Timbre to Deliver a Genderless Voice',
  'Cerence Reader Makes Earnings Call and Voice Tech History with Cloned Voices of CEO and CFO Presenting to Analysts',
];

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
        { host: '127.0.0.1', port, path, method, headers },
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

async function postLatencyBreach(devinOrgId = 'presenter-org') {
  const response = await request('POST', '/api/ea983805/search', {
    q: 'voice',
    devinUserId: 'presenter-user',
    devinOrgId,
    devinEmail: 'presenter@example.com',
  });
  await tick();
  return response;
}

function shrinkLatency() {
  INDEX_QUERY_POLICY.latencyMs = [2, 4];
  LATENCY_SLO.budgetMs = 1;
}

beforeEach(() => resetLatencyAlertCooldowns());

afterEach(() => {
  INDEX_QUERY_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Cerence AI site search', () => {
  test('serves config and returns the top 10 "voice" results across every content index', async () => {
    INDEX_QUERY_POLICY.latencyMs = [0, 0];

    const config = await request('GET', '/api/ea983805/config');
    expect(config.status).toBe(200);
    expect(config.body).toEqual({
      success: true,
      scopes: SCOPES,
      defaultQuery: 'voice',
      maxResults: 10,
      budgetMs: 3000,
    });

    const { status, body } = await request('POST', '/api/ea983805/search', { q: 'voice' });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      requestId: expect.stringMatching(REQUEST_ID),
      query: 'voice',
      scope: 'all',
      scopeLabel: 'All content',
      timing: { budgetMs: 3000, indexesQueried: 14 },
    });
    expect(body.totalMatches).toBeGreaterThan(10);
    expect(body.results.map(({ title }) => title)).toEqual(VOICE_TOP_TEN);
    expect(body.results[0]).toEqual({
      title: VOICE_TOP_TEN[0],
      url: 'https://voicetechpodcast.com/episodes/voice-ux-for-self-driving-cars-adam-emfield-cerence-voice-tech-podcast-ep-046/',
      source: 'Voice Tech Podcast',
      external: true,
      type: 'in the news',
    });
    expect(body.results[7]).toMatchObject({ type: 'blog', external: false });
    expect(CONTENT_INDEXES).toHaveLength(14);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('queries a single index when a content type is selected', async () => {
    const startedAt = Date.now();
    const { status, body } = await request('POST', '/api/ea983805/search', {
      q: 'voice',
      scope: 'blog',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scopeLabel).toBe('Blog');
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every(({ type }) => type === 'blog')).toBe(true);
    expect(body.timing.indexesQueried).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns an empty result set for unmatched queries', async () => {
    const { status, body } = await request('POST', '/api/ea983805/search', {
      q: 'zzqx',
      scope: 'press-releases',
    });
    expect(status).toBe(200);
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
  });

  test('schedules a latency-breach alert while returning the successful search', async () => {
    INDEX_QUERY_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/ea983805/search', {
      q: 'voice',
      devinUserId: 'presenter-user',
      devinOrgId: 'presenter-org',
      devinEmail: 'presenter@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.results).toHaveLength(10);
    expect(body.timing.indexesQueried).toBe(14);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.issueTitle).toMatch(/^LatencyBudgetExceeded: POST \/api\/ea983805\/search took \d+ms \(budget 1ms\)$/);
    expect(alert.customer).toBe('ea983805');
    expect(alert.service).toBe('customer-ea983805-site-search');
    expect(alert.culprit).toBe('app/services/verticals/ea983805.js — searchContentIndexes');
    expect(alert.devinUserId).toBe('presenter-user');
    expect(alert.devinOrgId).toBe('presenter-org');
    expect(alert.slackMemberId).toBe('');
    expect(alert.promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(alert.promptAppendix).toContain('searchContentIndexes');
    expect(alert.promptAppendix).toContain('Promise.all');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/ea983805/search' },
      { key: 'scope', value: 'all' },
      { key: 'duration_ms', value: String(body.timing.totalMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.requestId,
      budgetMs: 1,
      indexesQueried: 14,
      query: 'voice',
    }));
  });

  test('suppresses a second latency-breach session during the cooldown', async () => {
    shrinkLatency();
    await postLatencyBreach('org-a');
    const { status } = await postLatencyBreach('org-a');
    expect(status).toBe(200);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('releases the cooldown when no investigation starts', async () => {
    shrinkLatency();
    createSessionAndAlert.mockResolvedValueOnce({ session: null, throttled: true });
    await postLatencyBreach('org-a');
    await postLatencyBreach('org-a');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('keeps latency-breach cooldowns independent by organization', async () => {
    shrinkLatency();
    await postLatencyBreach('org-a');
    await postLatencyBreach('org-b');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ q: '' }, 'QUERY_REQUIRED'],
    [{ q: '   ' }, 'QUERY_REQUIRED'],
    [{}, 'QUERY_REQUIRED'],
    [{ q: 'x'.repeat(101) }, 'QUERY_TOO_LONG'],
    [{ q: 'voice', scope: 'unsupported' }, 'INVALID_SCOPE'],
  ])('rejects invalid input with a structured 400 (%#)', async (body, code) => {
    const { status, body: response } = await request('POST', '/api/ea983805/search', body);
    expect(status).toBe(400);
    expect(response).toMatchObject({
      success: false,
      errorClass: 'ValidationError',
      code,
      requestId: expect.stringMatching(REQUEST_ID),
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
