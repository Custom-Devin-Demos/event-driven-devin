/* global beforeEach, describe, expect, jest, test */

const { setImmediate } = require('timers');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/linear', () => ({
  createLinearIssue: jest.fn().mockResolvedValue(null),
  addLinearComment: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/slack', () => ({
  postLinearIssueLink: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { createLinearIssue, addLinearComment } = require('../app/services/linear');
const { postLinearIssueLink } = require('../app/services/slack');
const { Sentry } = require('../app/telemetry/sentry');
const { getCustomerConfig, listAliases } = require('../config/customers');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const {
  availableToPromise,
  listLooks,
  addLookToBag,
  checkout,
  LINEAR_STATE_IN_PROGRESS_ID,
  LINEAR_STATE_IN_REVIEW_ID,
} = require('../app/services/verticals/74f7816c');
const router = require('../app/routes/verticals/74f7816c');

const SLUG = '74f7816c';

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path,
          method,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) })));
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

describe('Stitch Fix Freestyle checkout (74f7816c)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createLinearIssue.mockResolvedValue(null);
    createSessionAndAlert.mockResolvedValue(null);
  });

  test('registers the stitchfix alias on the shared Affirm Slack channel', () => {
    expect(listAliases().stitchfix).toBe(SLUG);
    expect(getCustomerConfig(SLUG).triggerMode).toBe('api');
  });

  test('lists three Stylist looks sized to the client with one low-stock item', () => {
    const { client, looks } = listLooks();
    expect(client.firstName).toBe('Vanessa');
    expect(looks).toHaveLength(3);
    const lowStock = looks.flatMap((look) => look.items).filter((item) => item.lowStock);
    expect(lowStock.map((item) => `${item.sku}:${item.size}`)).toEqual(['MS-4471:M']);
    expect(lowStock[0].available).toBe(1);
  });

  test('adding a look places a hold on every item in the client size', () => {
    const bag = addLookToBag({ lookId: 'look-weekend-errands' });
    expect(bag.cartId).toMatch(/^cart-/);
    expect(bag.lines).toHaveLength(5);
    bag.lines.forEach((line) => {
      expect(line.holdId).toMatch(/^hold-/);
      expect(line.quantity).toBe(1);
    });
  });

  test('rejects unknown looks', () => {
    expect(() => addLookToBag({ lookId: 'nope' })).toThrow('Unknown look');
  });

  test('checks out a look with plenty of stock', async () => {
    const bag = addLookToBag({ lookId: 'look-desk-to-dinner' });
    const order = await checkout({ cartId: bag.cartId, lines: bag.lines });
    expect(order.success).toBe(true);
    expect(order.orderId).toMatch(/^SF-/);
    expect(order.totalCents).toBe(6400 + 7800 + 7200 + 2800);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('genuinely sold-out stock is never promised', () => {
    expect(availableToPromise('MS-4471', 'L', [])).toBe(0);
  });

  test('checkout failure files an In Progress Linear ticket, alerts Slack and starts Devin', async () => {
    const issue = { id: 'issue-1', identifier: 'GTM-1', url: 'https://linear.app/cog-gtm/issue/GTM-1' };
    createLinearIssue.mockResolvedValue(issue);
    createSessionAndAlert.mockResolvedValue({ threadTs: '123.456', session: { sessionId: 's1', url: 'https://app.devin.ai/sessions/s1' } });

    const bag = addLookToBag({ lookId: 'look-weekend-errands' });
    let failure;
    try {
      await checkout({ cartId: bag.cartId, lines: bag.lines, devinEmail: 'vanessa.salas@cognition.ai' });
    } catch (error) {
      failure = error;
    }
    await flushAsyncWork();

    expect(failure).toBeDefined();
    expect(failure.statusCode).toBe(409);
    expect(failure.name).toBe('ItemUnavailableError');
    expect(Sentry.captureException).toHaveBeenCalledWith(failure, expect.objectContaining({
      tags: expect.objectContaining({ alert_path: 'instant' }),
    }));
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ severity: 'SEV-2' }));
    expect(createLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      stateId: LINEAR_STATE_IN_PROGRESS_ID,
      title: expect.stringContaining('[Stitch Fix Freestyle] ItemUnavailableError'),
    }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe(SLUG);
    expect(isInstantPathEvent({ culprit: alert.culprit, tags: [] })).toBe(true);
    expect(alert.promptAppendix).toContain('!freestyle_checkout_triage');
    expect(alert.promptAppendix).toContain('GTM-1');
    expect(alert.promptAppendix).toContain(LINEAR_STATE_IN_REVIEW_ID);
    expect(postLinearIssueLink).toHaveBeenCalledWith('123.456', issue, undefined);
    expect(addLinearComment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: 'issue-1',
      body: expect.stringContaining('https://app.devin.ai/sessions/s1'),
    }));
  });

  describe('routes', () => {
    test('GET looks and POST bag items', async () => {
      const looks = await call('GET', `/api/${SLUG}/looks`);
      expect(looks.status).toBe(200);
      const bag = await call('POST', `/api/${SLUG}/bag/items`, { lookId: 'look-fall-weekend' });
      expect(bag.status).toBe(200);
      expect(bag.body.lines).toHaveLength(3);
    });

    test('checkout of an empty bag is a 400', async () => {
      const res = await call('POST', `/api/${SLUG}/checkout`, { cartId: 'cart-x', lines: [] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMPTY_BAG');
    });

    test('checkout returns 409 with the unavailable items', async () => {
      const bag = await call('POST', `/api/${SLUG}/bag/items`, { lookId: 'look-weekend-errands' });
      const res = await call('POST', `/api/${SLUG}/checkout`, { cartId: bag.body.cartId, lines: bag.body.lines });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ITEM_UNAVAILABLE');
      expect(res.body.unavailable[0]).toEqual(expect.objectContaining({ sku: 'MS-4471', size: 'M' }));
    });
  });
});
