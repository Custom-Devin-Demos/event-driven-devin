/* global describe, expect, test, jest, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: { url: 'https://app.devin.ai/sessions/rc1' } })),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(() => Promise.resolve({ sessionId: 'devin-rc2', url: 'https://app.devin.ai/sessions/rc2' })),
}));
jest.mock('../app/services/jira', () => ({
  isConfigured: jest.fn(() => true),
  createIssue: jest.fn(() => Promise.resolve({ id: '1', key: 'MBA-901', url: 'https://cog-gtm.atlassian.net/browse/MBA-901' })),
  addComment: jest.fn(() => Promise.resolve({ id: '2' })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { createDevinSession } = require('../app/services/devin-api');
const jira = require('../app/services/jira');
const routes = require('../app/routes/verticals/cbe0ee4c');
const rc = require('../app/services/verticals/cbe0ee4c');

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) })));
      });
      req.on('error', (err) => server.close(() => reject(err)));
      req.end(payload);
    });
  });
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  jest.clearAllMocks();
  jira.isConfigured.mockReturnValue(true);
  rc._featureRequests.clear();
  rc._incidents.length = 0;
});

describe('RingCentral inbox', () => {
  test('returns the account, sender numbers and conversations', async () => {
    const res = await request('GET', '/api/cbe0ee4c/inbox');
    expect(res.status).toBe(200);
    expect(res.body.account.company).toBe('Summit Ridge Outfitters');
    expect(res.body.numbers.map((n) => n.id)).toEqual(['direct', 'sales', 'support']);
    expect(res.body.conversations[0].numberId).toBe('sales');
  });
});

describe('business SMS send', () => {
  test.each(['direct', 'support'])('delivers from the %s number without alerting', async (fromNumberId) => {
    const res = await request('POST', '/api/cbe0ee4c/sms', { fromNumberId, conversationId: 'cv-northwind', text: 'Quote sent!' });
    expect(res.status).toBe(200);
    expect(res.body.message.status).toBe('Delivered');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(jira.createIssue).not.toHaveBeenCalled();
  });

  test('rejects empty messages and unknown senders with 400', async () => {
    const empty = await request('POST', '/api/cbe0ee4c/sms', { fromNumberId: 'direct', conversationId: 'cv-northwind', text: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('EMPTY_MESSAGE');
    const unknown = await request('POST', '/api/cbe0ee4c/sms', { fromNumberId: 'nope', conversationId: 'cv-northwind', text: 'hi' });
    expect(unknown.status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('Sales main line (MIXED campaign) fails, files an unassigned Jira ticket and starts Devin', async () => {
    const res = await request('POST', '/api/cbe0ee4c/sms', { fromNumberId: 'sales', conversationId: 'cv-northwind', text: 'Quote sent!' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SMS_SEND_FAILED');
    expect(res.body.errorClass).toBe('TypeError');
    expect(res.body.jira.key).toBe('MBA-901');

    expect(jira.createIssue).toHaveBeenCalledTimes(1);
    const issue = jira.createIssue.mock.calls[0][0];
    expect(issue.projectKey).toBe('MBA');
    expect(issue.assigneeAccountId).toBeUndefined();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('cbe0ee4c');
    expect(alert.title).toContain('MBA-901');
    expect(alert.culprit).toContain('cbe0ee4c');

    await flush();
    await flush();
    const incidents = await request('GET', '/api/cbe0ee4c/incidents');
    expect(incidents.body.incidents[0]).toMatchObject({
      campaignId: 'CH4M9RT',
      jira: { key: 'MBA-901' },
      session: { url: 'https://app.devin.ai/sessions/rc1' },
      state: 'devin-investigating',
    });
    expect(jira.addComment).toHaveBeenCalledWith('MBA-901', expect.stringContaining('https://app.devin.ai/sessions/rc1'));
  });

  test('still alerts when Jira is not configured', async () => {
    jira.isConfigured.mockReturnValue(false);
    const res = await request('POST', '/api/cbe0ee4c/sms', { fromNumberId: 'sales', conversationId: 'cv-northwind', text: 'Quote sent!' });
    expect(res.status).toBe(500);
    expect(res.body.jira).toBeNull();
    expect(jira.createIssue).not.toHaveBeenCalled();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });
});

describe('greenfield feature requests', () => {
  test('review-research request starts a Devin session scoped to the repo', async () => {
    const res = await request('POST', '/api/cbe0ee4c/feature-requests', { mode: 'reviews', focus: 'phone' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ mode: 'reviews', focus: 'phone', state: 'working', sessionUrl: 'https://app.devin.ai/sessions/rc2' });
    const [prompt, opts] = createDevinSession.mock.calls[0];
    expect(prompt).toContain('Research online reviews');
    expect(prompt).toContain('Phone & call history');
    expect(prompt).toContain('Voice of the customer');
    expect(prompt).toContain('app/public/verticals/cbe0ee4c.html');
    expect(opts.repos).toEqual(['COG-GTM/event-driven-devin']);
    expect(opts.title).toContain('customer reviews');
  });

  test('unknown focus falls back to anywhere in the app', async () => {
    const res = await request('POST', '/api/cbe0ee4c/feature-requests', { mode: 'reviews', focus: 'nope' });
    expect(res.body.request.focus).toBe('any');
  });

  test('custom request validates length and quotes the text in the prompt', async () => {
    const short = await request('POST', '/api/cbe0ee4c/feature-requests', { request: 'hi' });
    expect(short.status).toBe(400);
    const ok = await request('POST', '/api/cbe0ee4c/feature-requests', { request: 'Let me schedule a text to send later.' });
    expect(ok.status).toBe(200);
    expect(ok.body.request.mode).toBe('custom');
    expect(createDevinSession.mock.calls[0][0]).toContain('> Let me schedule a text to send later.');
  });

  test('enforces the daily cap', async () => {
    process.env.RC_FEATURE_REQUESTS_PER_DAY = '1';
    try {
      expect((await request('POST', '/api/cbe0ee4c/feature-requests', { mode: 'reviews' })).status).toBe(200);
      const res = await request('POST', '/api/cbe0ee4c/feature-requests', { mode: 'reviews' });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('FEATURE_REQUEST_LIMIT');
    } finally {
      delete process.env.RC_FEATURE_REQUESTS_PER_DAY;
    }
  });

  test('lists focus areas and review sources', async () => {
    const res = await request('GET', '/api/cbe0ee4c/feature-requests');
    expect(res.body.focusAreas.length).toBeGreaterThan(1);
    expect(res.body.sources).toContain('G2');
  });
});
