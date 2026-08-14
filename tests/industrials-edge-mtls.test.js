jest.setTimeout(30000);

const logger = require('../app/telemetry/logger');
const https = require('https');
const { processQuote } = require('../app/services/oncall-verticals/industrials');
const {
  getClientSocketSiteCount,
  quoteAtEdge,
  startGateway,
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
    expect(getClientSocketSiteCount()).toBe(0);
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
    await new Promise((resolve) => setImmediate(resolve));
    expect(getClientSocketSiteCount()).toBe(0);
  });

  test('drains socket attribution across repeated healthy quotes', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await quoteAtEdge('f2-torrance', { site: 'f2-torrance' });
      expect(result).toEqual(expect.objectContaining({
        success: true,
        site: 'f2-torrance',
      }));
      expect(getClientSocketSiteCount()).toBe(0);
    }
  });

  test('rebuilds the gateway after it closes', async () => {
    const firstGateway = await startGateway();
    await stopGateway();
    const secondGateway = await startGateway();

    expect(secondGateway).not.toBe(firstGateway);
    await expect(quoteAtEdge('f2-torrance', { site: 'f2-torrance' }))
      .resolves.toEqual(expect.objectContaining({
        success: true,
        site: 'f2-torrance',
      }));
    await stopGateway();
  });

  test('recovers after a listen failure', async () => {
    await stopGateway();
    const createServer = https.createServer;
    let failedServer;
    jest.spyOn(https, 'createServer').mockImplementationOnce((...args) => {
      failedServer = createServer(...args);
      failedServer.listen = () => {
        setImmediate(() => failedServer.emit('error', new Error('listen failed')));
      };
      return failedServer;
    });

    await expect(startGateway()).resolves.toBeNull();
    expect(failedServer.listening).toBe(false);
    https.createServer.mockRestore();

    const freshServer = await startGateway();
    expect(freshServer).not.toBe(failedServer);
    await expect(quoteAtEdge('f2-torrance', { site: 'f2-torrance' }))
      .resolves.toEqual(expect.objectContaining({
        success: true,
        site: 'f2-torrance',
      }));
    await stopGateway();
  });

  test('falls back when gateway setup throws synchronously', async () => {
    await stopGateway();
    const createServerSpy = jest.spyOn(https, 'createServer')
      .mockImplementation(() => {
        throw new Error('server setup failed');
      });

    await expect(processQuote({
      site: 'f2-torrance',
      partNumber: 'TM-DFM-4400',
      quantity: 25,
    }, { debugTimings: true })).resolves.toEqual(expect.objectContaining({
      success: true,
      fallback: true,
      site: 'f2-torrance',
    }));

    createServerSpy.mockRestore();
    await stopGateway();
  });

  test('does not cache a gateway setup failure', async () => {
    await stopGateway();
    const createServerSpy = jest.spyOn(https, 'createServer')
      .mockImplementation(() => {
        throw new Error('server setup failed');
      });

    await expect(startGateway()).resolves.toBeNull();
    createServerSpy.mockRestore();

    const freshServer = await startGateway();
    expect(freshServer).toBeTruthy();
    await expect(quoteAtEdge('f2-torrance', { site: 'f2-torrance' }))
      .resolves.toEqual(expect.objectContaining({
        success: true,
        site: 'f2-torrance',
      }));
    await stopGateway();
  });
});
