/* global afterAll, describe, expect, jest, test */

const express = require('express');
const http = require('http');

const { submitClaim, VENDORS } = require('../app/services/oncall-verticals/pbm');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

jest.setTimeout(30000);

describe('pharmacy claim submission', () => {
  test('times out with ADJUDICATION_TIMEOUT', async () => {
    await expect(submitClaim({
      memberId: 'FRX-100245-01',
      ndc: '00093505898',
      pharmacyId: '4012345',
      quantity: 30,
      daysSupply: 30,
    })).rejects.toMatchObject({ code: 'ADJUDICATION_TIMEOUT' });
  });

  test('rejects an unknown NDC and a terminated member without probing vendors', async () => {
    const unknownNdcStarted = Date.now();
    await expect(submitClaim({ memberId: 'FRX-100245-01', ndc: '00000000000' }))
      .rejects.toMatchObject({ code: 'NDC_NOT_COVERED' });
    expect(Date.now() - unknownNdcStarted).toBeLessThan(500);

    const terminatedMemberStarted = Date.now();
    await expect(submitClaim({ memberId: 'FRX-311902-01', ndc: '00093505898' }))
      .rejects.toMatchObject({ code: 'MEMBER_NOT_ELIGIBLE' });
    expect(Date.now() - terminatedMemberStarted).toBeLessThan(500);
  });

  test('returns claim totals for generic and specialty drugs when adjudication completes', async () => {
    const trimmed = VENDORS.splice(2);
    try {
      const generic = await submitClaim({
        memberId: 'FRX-100245-01',
        ndc: '00093505898',
        pharmacyId: '4012345',
        quantity: 30,
        daysSupply: 30,
      });
      expect(generic).toMatchObject({
        success: true,
        status: 'PAID',
        claimId: expect.stringMatching(/^CLM-[0-9A-F]{8}$/),
        ingredientCost: 3.6,
        dispensingFee: 1.75,
        memberCopay: 5,
        planPays: 0.35,
      });

      const specialty = await submitClaim({
        memberId: 'FRX-100245-01',
        ndc: '61314064705',
        pharmacyId: '4012345',
        quantity: 2,
        daysSupply: 30,
      });
      expect(specialty).toMatchObject({
        success: true,
        status: 'PAID',
        ingredientCost: 2900,
        memberCopay: 250,
        planPays: 2651.75,
      });
    } finally {
      VENDORS.push(...trimmed);
    }
  });
});

describe('POST /api/oncall/pbm/claim', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(oncallVerticalRoutes);
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => stopGateway().then(() => done()));
  });

  test('answers 504 with ADJUDICATION_TIMEOUT after about eight seconds', async () => {
    const started = Date.now();
    const response = await fetch(`${baseUrl}/api/oncall/pbm/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const elapsed = Date.now() - started;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'ADJUDICATION_TIMEOUT',
      error: expect.stringMatching(/timed out during adjudication/),
    });
    expect(elapsed).toBeGreaterThanOrEqual(7900);
  });
});
