jest.setTimeout(30000);

const logger = require('../app/telemetry/logger');
const { processQuote } = require('../app/services/oncall-verticals/industrials');
const {
  quoteAtEdge,
  stopGateway,
} = require('../app/services/oncall-verticals/industrials-edge');

describe('industrials instant quote mTLS path', () => {
  let warnSpy;

  beforeAll(() => {
    warnSpy = jest.spyOn(logger, 'warn');
  });

  afterAll(async () => {
    warnSpy.mockRestore();
    await stopGateway();
  });

  test('healthy factory sites complete edge DFM in about 310ms', async () => {
    const result = await processQuote({
      site: 'f2-torrance',
      partNumber: 'TM-DFM-4400',
      quantity: 25,
    }, { debugTimings: true });

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.site).toBe('f2-torrance');
    expect(result.phaseTimings.totalMs).toBeGreaterThan(240);
    expect(result.phaseTimings.totalMs).toBeLessThan(500);
    expect(result.phaseTimings.cloudQueueMs).toBe(0);
  });

  test('expired F3 client cert decomposes into edge retries and cloud fallback', async () => {
    const result = await processQuote({
      site: 'f3-mesa',
      partNumber: 'TM-DFM-4400',
      quantity: 25,
    }, { debugTimings: true });

    expect(result.success).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.phaseTimings.edgeAttemptMs).toBeGreaterThan(2100);
    expect(result.phaseTimings.edgeAttemptMs).toBeLessThan(2800);
    expect(result.phaseTimings.cloudQueueMs).toBeGreaterThan(11500);
    expect(result.phaseTimings.cloudQueueMs).toBeLessThan(12500);
    expect(result.phaseTimings.totalMs).toBeGreaterThan(13600);
    expect(result.phaseTimings.totalMs).toBeLessThan(15000);

    const gatewayRejection = warnSpy.mock.calls.find(([message]) => (
      message === 'Industrial edge mTLS client rejected'
    ));
    expect(gatewayRejection).toBeDefined();
    expect(gatewayRejection[1]).toEqual(expect.objectContaining({
      service: 'industrials-edge-gateway',
      site: 'f3-mesa',
      authorizationError: 'CERT_HAS_EXPIRED',
      clientCertSubjectCn: 'f3-mesa',
    }));
  });

  test('attributes an F3 rejection correctly while an F2 quote is in flight', async () => {
    warnSpy.mockClear();
    const f3 = quoteAtEdge('f3-mesa', { site: 'f3-mesa' }).catch((error) => error);
    const f2 = quoteAtEdge('f2-torrance', { site: 'f2-torrance' });
    const [f3Result, f2Result] = await Promise.all([f3, f2]);

    expect(f3Result).toEqual(expect.objectContaining({
      code: 'ECONNRESET',
    }));
    expect(f2Result).toEqual(expect.objectContaining({
      success: true,
      site: 'f2-torrance',
    }));
    const gatewayRejection = warnSpy.mock.calls.find(([message, details]) => (
      message === 'Industrial edge mTLS client rejected'
      && details.site === 'f3-mesa'
    ));
    expect(gatewayRejection).toBeDefined();
    expect(gatewayRejection[1]).toEqual(expect.objectContaining({
      clientCertSubjectCn: 'f3-mesa',
      authorizationError: 'CERT_HAS_EXPIRED',
    }));
  });
});
