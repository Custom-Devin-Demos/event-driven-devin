/* global describe, expect, test, jest, beforeEach, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: { url: 'https://app.devin.ai/sessions/abc' } })),
}));
jest.mock('../app/services/jira', () => ({
  isConfigured: jest.fn(() => true),
  createIssue: jest.fn(() => Promise.resolve({ id: '1', key: 'MBA-900', url: 'https://cog-gtm.atlassian.net/browse/MBA-900' })),
  addComment: jest.fn(() => Promise.resolve({ id: '2' })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const jira = require('../app/services/jira');
const routes = require('../app/routes/verticals/b19cd3b6');
const {
  postDailySalesSummary,
  getDailySalesSummary,
  buildJournalEntry,
  GL_PAYMENT_MAP,
  JIRA_ASSIGNEE_ACCOUNT_ID,
} = require('../app/services/verticals/b19cd3b6');

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
});

describe('Daily Sales Summary fixtures', () => {
  test.each(['102', '104'])('location %s payments equal gross sales', (id) => {
    const dss = getDailySalesSummary(id);
    expect(dss.totalPayments).toBe(dss.grossSales);
    expect(dss.overShort).toBe(0);
  });
});

describe('postDailySalesSummary', () => {
  test('posts a balanced journal entry for #102 without alerting', async () => {
    const result = await postDailySalesSummary({ locationId: '102', businessDate: '2026-09-28' });
    expect(result.success).toBe(true);
    expect(result.journalEntry.number).toBe('JE-20260928-102');
    expect(result.journalEntry.balanced).toBe(true);
    expect(jira.createIssue).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unknown location with a 400 and no alert', async () => {
    await expect(postDailySalesSummary({ locationId: '999' })).rejects.toMatchObject({
      statusCode: 400, code: 'DSS_LOCATION_REQUIRED',
    });
    expect(jira.createIssue).not.toHaveBeenCalled();
  });

  test('#104 failure files a Jira bug assigned to Shahmir, then starts Devin with the Jira key', async () => {
    const error = await postDailySalesSummary({
      locationId: '104', businessDate: '2026-09-28', devinEmail: 'shahmir.masood@cognition.ai',
    }).catch((e) => e);

    expect(error.name).toBe('TypeError');
    expect(error.jira).toEqual({ key: 'MBA-900', url: 'https://cog-gtm.atlassian.net/browse/MBA-900' });

    expect(jira.createIssue).toHaveBeenCalledTimes(1);
    const issue = jira.createIssue.mock.calls[0][0];
    expect(issue).toMatchObject({
      projectKey: 'MBA',
      issueType: 'Bug',
      priority: 'High',
      assigneeAccountId: JIRA_ASSIGNEE_ACCOUNT_ID,
    });
    expect(JIRA_ASSIGNEE_ACCOUNT_ID).toBe('712020:b8c6e298-ac94-4127-b5d1-d5e182e57b49');
    expect(issue.summary).toContain('COG-GTM/event-driven-devin');
    expect(issue.labels).toEqual(expect.arrayContaining(['restaurant365', 'sentry', 'devin-remediation']));
    const description = JSON.stringify(issue.description);
    expect(description).toContain('DoorDash Drive (doordash_drive)');
    expect(description).toContain('Acceptance criteria');
    expect(description).toContain('buildJournalEntry');

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('b19cd3b6');
    expect(alert.title).toBe('MBA-900: Restaurant365 DSS post failure');
    expect(alert.promptAppendix).toContain('*Jira ticket:* MBA-900 - https://cog-gtm.atlassian.net/browse/MBA-900');
    expect(alert.promptAppendix).toContain('Review loop');
    expect(alert.devinEmail).toBe('shahmir.masood@cognition.ai');

    await flush();
    expect(jira.addComment).toHaveBeenCalledWith('MBA-900', expect.stringContaining('https://app.devin.ai/sessions/abc'));
  });

  test('still starts Devin when Jira is not configured', async () => {
    jira.isConfigured.mockReturnValue(false);
    const error = await postDailySalesSummary({ locationId: '104' }).catch((e) => e);
    expect(error.jira).toBeNull();
    expect(jira.createIssue).not.toHaveBeenCalled();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0].promptAppendix).toContain('Jira ticket:* not created');
  });

  describe('once doordash_drive is mapped', () => {
    beforeEach(() => {
      GL_PAYMENT_MAP.doordash_drive = { glAccount: '1145', name: 'Third-Party Delivery Clearing - DoorDash Drive' };
    });
    afterEach(() => {
      delete GL_PAYMENT_MAP.doordash_drive;
    });

    test('#104 posts a balanced journal entry', () => {
      const journal = buildJournalEntry(getDailySalesSummary('104', '2026-09-28'));
      expect(journal.balanced).toBe(true);
      expect(journal.totalDebits).toBe(14686.55);
    });
  });
});

describe('routes', () => {
  test('GET /api/b19cd3b6/locations lists both locations', async () => {
    const res = await request('GET', '/api/b19cd3b6/locations');
    expect(res.body.locations.map((l) => l.id)).toEqual(['102', '104']);
  });

  test('GET /api/b19cd3b6/dss returns 404 for unknown locations', async () => {
    const res = await request('GET', '/api/b19cd3b6/dss?locationId=nope');
    expect(res.status).toBe(404);
  });

  test('POST /api/b19cd3b6/dss/post returns 500 with Jira + Sentry details for #104', async () => {
    const res = await request('POST', '/api/b19cd3b6/dss/post', { locationId: '104' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      errorClass: 'TypeError',
      jira: { key: 'MBA-900' },
    });
    expect(res.body.postId).toMatch(/^DSS-/);
  });

  test('POST /api/b19cd3b6/dss/post succeeds for #102', async () => {
    const res = await request('POST', '/api/b19cd3b6/dss/post', { locationId: '102' });
    expect(res.status).toBe(200);
    expect(res.body.journalEntry.balanced).toBe(true);
  });
});
