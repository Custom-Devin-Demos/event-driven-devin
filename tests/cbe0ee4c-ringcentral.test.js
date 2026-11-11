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
  rc._ticketFilings.clear();
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

describe('incident dedupe and org-scoped polling', () => {
  test('repeat Sales-line failures reuse the open Jira ticket', async () => {
    await request('POST', '/api/cbe0ee4c/sms', { fromNumberId: 'sales', conversationId: 'cv-northwind', text: 'one' });
    const second = await request('POST', '/api/cbe0ee4c/sms', { fromNumberId: 'sales', conversationId: 'cv-northwind', text: 'two' });
    expect(jira.createIssue).toHaveBeenCalledTimes(1);
    expect(second.body.jira.key).toBe('MBA-901');
  });

  test('concurrent Sales-line failures file a single Jira ticket', async () => {
    const body = (text) => ({ fromNumberId: 'sales', conversationId: 'cv-northwind', text });
    await Promise.all([request('POST', '/api/cbe0ee4c/sms', body('a')), request('POST', '/api/cbe0ee4c/sms', body('b'))]);
    expect(jira.createIssue).toHaveBeenCalledTimes(1);
  });

  test('voice QA request remembers the org it was created in', async () => {
    await request('POST', '/api/cbe0ee4c/recordings/qa-sales-sms/qa', { devinOrgId: 'org-other' });
    expect(createDevinSession.mock.calls[0][1].orgId).toBe('org-other');
    expect([...rc._featureRequests.values()][0].orgId).toBe('org-other');
  });
});

describe('voice QA from call recordings', () => {
  test('lists recordings with audio, waveform and timed transcript', async () => {
    const res = await request('GET', '/api/cbe0ee4c/recordings');
    expect(res.status).toBe(200);
    const qa = res.body.recordings.find((r) => r.id === 'qa-sales-sms');
    expect(qa.audio).toBe('/verticals/cbe0ee4c-audio/qa-sales-sms.mp3');
    expect(qa.peaks.length).toBeGreaterThan(50);
    expect(qa.segments[0]).toEqual(expect.objectContaining({ speaker: 'Alex Rivera', start: 0 }));
    expect(qa.segments.map((s) => s.text).join(' ')).toMatch(/Sales main line/);
  });

  test('every recording audio file exists', () => {
    const fs = require('fs');
    const path = require('path');
    rc.listRecordings().forEach((r) => {
      expect(fs.existsSync(path.join(__dirname, '..', 'app', 'public', r.audio))).toBe(true);
    });
  });

  test('starts a scoped Devin QA session from a recording', async () => {
    const res = await request('POST', '/api/cbe0ee4c/recordings/qa-sales-sms/qa', { name: 'Jordan Ellis' });
    expect(res.status).toBe(200);
    expect(res.body.request).toEqual(expect.objectContaining({ mode: 'voice-qa', recordingId: 'qa-sales-sms', state: 'working' }));
    const [prompt, opts] = createDevinSession.mock.calls[0];
    expect(opts.title).toBe('RingCentral QA: Alex Rivera call → regression tests');
    expect(opts.repos).toEqual(['COG-GTM/event-driven-devin']);
    expect(prompt).toContain('app/public/verticals/cbe0ee4c-audio/qa-sales-sms.mp3');
    expect(prompt).toMatch(/transcribe the audio yourself/i);
    expect(prompt).toContain('tests/cbe0ee4c-voice-qa.test.js');
    expect(prompt).toContain('test.failing');
    expect(prompt).toMatch(/Do not fix product code/);
  });

  test('rejects unknown recordings and enforces the daily cap', async () => {
    expect((await request('POST', '/api/cbe0ee4c/recordings/nope/qa', {})).status).toBe(400);
    for (let i = 0; i < rc.dailyCap(); i += 1) {
      await request('POST', '/api/cbe0ee4c/recordings/priya-quote/qa', {});
    }
    const res = await request('POST', '/api/cbe0ee4c/recordings/qa-sales-sms/qa', {});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('FEATURE_REQUEST_LIMIT');
    expect((await request('GET', '/api/cbe0ee4c/feature-requests')).body.usedToday).toBe(rc.dailyCap());
  });
});
