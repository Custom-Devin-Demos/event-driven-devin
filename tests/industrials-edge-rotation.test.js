jest.setTimeout(30000);

const logger = require('../app/telemetry/logger');
const { processQuote } = require('../app/services/oncall-verticals/industrials');
const {
  cleanupCertificateMaterial,
  clientCertificateFor,
  ensureCertificateMaterial,
  ROTATION_ENROLLMENT,
  startGateway,
  stopGateway,
} = require('../app/services/oncall-verticals/industrials-edge');

describe('industrials edge certificate rotation', () => {
  let infoSpy;
  let warnSpy;

  beforeAll(async () => {
    infoSpy = jest.spyOn(logger, 'info');
    warnSpy = jest.spyOn(logger, 'warn');
    await ensureCertificateMaterial();
    await startGateway();
  });

  afterAll(async () => {
    await stopGateway();
    cleanupCertificateMaterial();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('renews enrolled leaves before inspection and leaves Mesa lapsed', () => {
    expect(ROTATION_ENROLLMENT).toEqual(['f2-torrance', 'f4-alabama']);
    expect(clientCertificateFor('f2-torrance').daysToExpiry).toBeGreaterThan(29);
    expect(clientCertificateFor('f4-alabama').daysToExpiry).toBeGreaterThan(29);
    expect(clientCertificateFor('f3-mesa').daysToExpiry).toBeLessThan(-0.9);

    const rotatedSites = infoSpy.mock.calls
      .filter(([message]) => message === 'Industrial edge client certificate rotated')
      .map(([, details]) => details.site);
    expect(rotatedSites).toEqual(['f2-torrance', 'f4-alabama']);
    expect(infoSpy.mock.calls).toEqual(expect.arrayContaining([
      [
        'Industrial edge client certificate loaded',
        expect.objectContaining({
          site: 'f2-torrance',
          daysToExpiry: expect.any(Number),
        }),
      ],
      [
        'Industrial edge client certificate loaded',
        expect.objectContaining({
          site: 'f3-mesa',
          daysToExpiry: expect.any(Number),
        }),
      ],
      [
        'Industrial edge client certificate loaded',
        expect.objectContaining({
          site: 'f4-alabama',
          daysToExpiry: expect.any(Number),
        }),
      ],
    ]));
  });

  test('enrolling Mesa and restarting restores its edge quote path', async () => {
    await stopGateway();
    cleanupCertificateMaterial();
    ROTATION_ENROLLMENT.push('f3-mesa');
    try {
      infoSpy.mockClear();
      warnSpy.mockClear();
      await expect(ensureCertificateMaterial()).resolves.toBeTruthy();
      await expect(startGateway()).resolves.toBeTruthy();

      expect(clientCertificateFor('f3-mesa').daysToExpiry).toBeGreaterThan(29);
      const result = await processQuote({
        site: 'f3-mesa',
        partNumber: 'TM-DFM-4400',
        quantity: 25,
      }, { debugTimings: true });

      expect(result.success).toBe(true);
      expect(result.fallback).toBe(false);
      expect(result.phaseTimings.totalMs).toBeGreaterThan(240);
      expect(result.phaseTimings.totalMs).toBeLessThan(500);
      expect(warnSpy.mock.calls.some(([message]) => message === 'Industrial edge mTLS client rejected'))
        .toBe(false);
    } finally {
      ROTATION_ENROLLMENT.splice(ROTATION_ENROLLMENT.indexOf('f3-mesa'), 1);
      await stopGateway();
      cleanupCertificateMaterial();
    }
  });
});
