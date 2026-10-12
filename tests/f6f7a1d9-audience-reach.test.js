/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/f6f7a1d9');
const {
  estimateAudienceReach,
  PARTNERS,
  CHANNEL_SCOPES,
  SEGMENTS,
  MARKETS,
  PARTNER_MATCH_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/f6f7a1d9');

const ORIGINAL_LATENCY = [...PARTNER_MATCH_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const VALID = { company: 'Acme Retail', email: 'jane@acme.com' };

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
      const req = http.request({
        host: '127.0.0.1', port, path, method, headers,
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  PARTNER_MATCH_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Claritas AudienceAnywhere audience reach', () => {
  test('default scope queries all activation partners in directory order with defaults', async () => {
    PARTNER_MATCH_POLICY.latencyMs = [1, 2];

    const result = await estimateAudienceReach(VALID);

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^CL-[0-9A-F]{8}$/);
    expect(result.company).toBe('Acme Retail');
    expect(result.segment).toEqual({ key: 'prizm_04', code: '04', label: 'Young Digerati' });
    expect(result.market).toEqual({ key: 'national', label: 'National (all U.S. DMAs)' });
    expect(result.channels).toEqual({ key: 'all', label: 'All activation partners' });
    expect(result.partnersQueried).toBe(PARTNERS.length);
    expect(result.partners.map((partner) => partner.partnerKey)).toEqual(PARTNERS.map((partner) => partner.key));
  });

  test('partner counts and unique reach are internally consistent', async () => {
    PARTNER_MATCH_POLICY.latencyMs = [1, 2];
    const result = await estimateAudienceReach(VALID);

    result.partners.forEach((partnerResult) => {
      const partner = PARTNERS.find((entry) => entry.key === partnerResult.partnerKey);
      expect(partnerResult.matchedHouseholds).toBeLessThanOrEqual(result.segmentHouseholds);
      expect(partnerResult.matchedDevices).toBeGreaterThanOrEqual(partnerResult.matchedHouseholds);
      expect(partnerResult.matchRate).toBeGreaterThanOrEqual(partner.matchRate[0]);
      expect(partnerResult.matchRate).toBeLessThanOrEqual(partner.matchRate[1]);
    });
    expect(result.uniqueReachableHouseholds).toBeGreaterThanOrEqual(
      Math.max(...result.partners.map((partner) => partner.matchedHouseholds)),
    );
    expect(result.uniqueReachableHouseholds).toBeLessThanOrEqual(result.segmentHouseholds);
    expect(result.totalMatchedDevices).toBe(
      result.partners.reduce((sum, partner) => sum + partner.matchedDevices, 0),
    );
  });

  test('results are deterministic for the same request', async () => {
    PARTNER_MATCH_POLICY.latencyMs = [1, 2];
    const first = await estimateAudienceReach(VALID);
    const second = await estimateAudienceReach(VALID);

    expect(second.segmentHouseholds).toBe(first.segmentHouseholds);
    expect(second.partners).toEqual(first.partners);
    expect(second.uniqueReachableHouseholds).toBe(first.uniqueReachableHouseholds);
    expect(second.totalMatchedDevices).toBe(first.totalMatchedDevices);
  });

  test.each(['liveramp', 'thetradedesk', 'claritas_email'])(
    'single-partner scope %p returns quickly without alerting',
    async (channels) => {
      const started = Date.now();
      const result = await estimateAudienceReach({ ...VALID, channels });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.partnersQueried).toBe(1);
      expect(result.partners.map((partner) => partner.partnerKey)).toEqual(CHANNEL_SCOPES[channels].partners);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    },
  );

  test.each([
    [{ ...VALID, company: ' ' }, 'COMPANY_INVALID'],
    [{ ...VALID, email: 'nope' }, 'EMAIL_INVALID'],
    [{ ...VALID, segment: 'unknown' }, 'SELECTION_INVALID'],
    [{ ...VALID, market: 'unknown' }, 'SELECTION_INVALID'],
    [{ ...VALID, channels: 'unknown' }, 'SELECTION_INVALID'],
  ])('rejects invalid input with a structured 400 (%#)', async (body, code) => {
    const response = await request('POST', '/api/f6f7a1d9/audience-reach', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, errorClass: 'ValidationError', code });
    expect(response.body.error).toEqual(expect.any(String));
    expect(response.body.requestId).toMatch(/^CL-[0-9A-F]{8}$/);
  });

  test('POST route returns the audience reach payload for a fast scope', async () => {
    PARTNER_MATCH_POLICY.latencyMs = [1, 2];
    const response = await request('POST', '/api/f6f7a1d9/audience-reach', {
      ...VALID,
      channels: 'liveramp',
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.partners[0].partnerKey).toBe('liveramp');
  });

  test('GET catalog lists segments, markets, channel scopes, and partners', async () => {
    const response = await request('GET', '/api/f6f7a1d9/catalog');

    expect(response.status).toBe(200);
    expect(response.body.segments).toHaveLength(SEGMENTS.length);
    expect(response.body.markets).toHaveLength(MARKETS.length);
    expect(response.body.channels.find((channel) => channel.key === 'all').partnerCount).toBe(PARTNERS.length);
    expect(response.body.partners).toHaveLength(PARTNERS.length);
  });

  test('a latency budget breach triggers the Devin alert', async () => {
    PARTNER_MATCH_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const result = await estimateAudienceReach({
      ...VALID,
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: '',
    });
    await tick();

    expect(result.success).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const payload = createSessionAndAlert.mock.calls[0][0];
    expect(payload.errorType).toBe('LatencyBudgetExceeded');
    expect(payload.issueTitle).toMatch(/^LatencyBudgetExceeded: POST \/api\/f6f7a1d9\/audience-reach took \d+ms \(budget 1ms\)$/);
    expect(payload.culprit).toBe('app/services/verticals/f6f7a1d9.js — collectPartnerMatchCounts');
    expect(payload.customer).toBe('f6f7a1d9');
    expect(payload.devinUserId).toBe('user-1');
    expect(payload.devinOrgId).toBe('org-1');
    expect(payload.promptAppendix).toContain('collectPartnerMatchCounts');
    expect(payload.extra.partnersQueried).toBe(14);
  });
});
