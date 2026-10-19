const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  CARD,
  CardLockTimeoutError,
  ERROR_BUBBLE_CLASS,
  TIMEOUT_MESSAGE,
  buildLockLatencyReport,
  createCardControls,
  createLockLatencyReporter,
  createSystemClock,
  lockFailureMessage,
  parseUserAgent,
  reportsEnabledFromSearch,
} = require('../app/public/verticals/e91b0f39/js/card-controls');

describe('e91b0f39 web card controls', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('times out during recurring merchant checks without sending a lock request', async () => {
    const reportLockLatency = jest.fn();
    const controls = createCardControls({
      clock: createSystemClock(),
      reporter: { reportLockLatency },
    });
    const pendingLock = controls.lock(CARD);
    let settled = false;
    pendingLock.catch(() => { settled = true; });

    await jest.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const timeoutError = await pendingLock.catch((error) => error);
    expect(timeoutError).toMatchObject({
      name: 'CardLockTimeoutError',
      message: TIMEOUT_MESSAGE,
    });

    const lockRequests = controls.transport.log.filter((entry) => entry.path.endsWith('/lock'));
    expect(lockRequests).toHaveLength(0);
    expect(controls.transport.log).toHaveLength(20);
    expect(controls.transport.log.filter((entry) => entry.path.endsWith('/recurring-merchants'))).toHaveLength(1);
    expect(controls.transport.log.filter((entry) => entry.path.endsWith('/status'))).toHaveLength(19);

    expect(timeoutError).toBeInstanceOf(CardLockTimeoutError);
    expect(timeoutError.measurement).toMatchObject({
      durationMs: 5000,
      outcome: 'timeout',
      merchantCount: 38,
      requestCount: 20,
    });
    await jest.advanceTimersByTimeAsync(5000);
    expect(controls.transport.log.filter((entry) => entry.path.endsWith('/lock'))).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('uses the error bubble only for lock timeouts', () => {
    expect(lockFailureMessage(new CardLockTimeoutError(null))).toEqual({
      text: TIMEOUT_MESSAGE,
      variant: 'error',
      className: ERROR_BUBBLE_CLASS,
    });
    expect(lockFailureMessage(new Error('Request failed'))).toEqual({
      text: "Sorry, I couldn't lock your card right now. Please try again.",
      variant: 'default',
      className: '',
    });
  });

  test('reports a timeout once and leaves reporting disabled without a fetch', async () => {
    const reportLockLatency = jest.fn();
    const controls = createCardControls({
      clock: createSystemClock(),
      reporter: { reportLockLatency },
    });
    const pendingLock = controls.lock(CARD);
    const outcome = pendingLock.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await jest.advanceTimersByTimeAsync(5000);
    const { error } = await outcome;

    await controls.telemetry.lastReportDelivery;
    expect(error).toBeInstanceOf(CardLockTimeoutError);
    expect(reportLockLatency).toHaveBeenCalledTimes(1);
    expect(reportLockLatency.mock.calls[0][0]).toMatchObject({
      durationMs: 5000,
      outcome: 'timeout',
      merchantCount: 38,
      requestCount: 20,
    });

    const fetchImpl = jest.fn();
    const disabledReporter = createLockLatencyReporter({
      enabled: false,
      fetchImpl,
      log: jest.fn(),
    });
    await disabledReporter.reportLockLatency(error.measurement, CARD);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('sends the desktop report fields when reporting is enabled', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ reference: 'CL-abc123' }),
    });
    const reporter = createLockLatencyReporter({
      enabled: true,
      fetchImpl,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      ownerEmail: 'owner@example.com',
      log: jest.fn(),
    });
    const controls = createCardControls({
      clock: createSystemClock(),
      reporter,
    });
    const pendingLock = controls.lock(CARD);
    const outcome = pendingLock.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(5000);
    await outcome;
    await controls.telemetry.lastReportDelivery;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
    expect(fetchImpl.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      source: 'card-controls-web/desktop',
      service: 'card-controls-web',
      platform: 'web',
      durationMs: 5000,
      outcome: 'timeout',
      cardLast4: '4417',
      cardType: 'debit',
      sloMs: 3000,
      devinEmail: 'owner@example.com',
    });
    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(payload.spans.length).toBeLessThanOrEqual(6);
    expect(payload.device).toBe('Chrome 141 / macOS');
  });

  test('omits devinEmail when no owner email is available', () => {
    const report = buildLockLatencyReport({
      reportId: 'CL-abc123',
      durationMs: 5000,
      requestCount: 39,
      merchantCount: 38,
      spans: [],
      outcome: 'timeout',
    }, CARD);

    expect(report).not.toHaveProperty('devinEmail');
  });

  test('reads report configuration and parses browser user agents', () => {
    expect(reportsEnabledFromSearch('?reports=off')).toBe(false);
    expect(reportsEnabledFromSearch('')).toBe(true);
    expect(reportsEnabledFromSearch('?x=1')).toBe(true);

    const chrome = parseUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    );
    expect(chrome.device).toBe('Chrome 141 / macOS');
    expect(chrome.osVersion).toBe('macOS 10.15.7');

    const edge = parseUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    );
    expect(edge.device).toBe('Edge 141 / Windows');
    expect(edge.osVersion).toBe('Windows 10');
  });

  test('unlocks the card and returns an unlock reference', async () => {
    const controls = createCardControls({ clock: createSystemClock() });
    const pendingUnlock = controls.unlock(CARD);
    await jest.advanceTimersByTimeAsync(300);
    await expect(pendingUnlock).resolves.toMatchObject({
      cardId: CARD.id,
      reference: 'UL-000001',
    });
  });
});

describe('e91b0f39 page route', () => {
  const pagePath = path.join(__dirname, '..', 'app', 'public', 'verticals', 'e91b0f39', 'index.html');
  const pageExists = fs.existsSync(pagePath);

  (pageExists ? test : test.skip)('serves the desktop page without caching', async () => {
    const app = express();
    app.use(require('../app/routes/verticals/e91b0f39'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const response = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${server.address().port}/e91b0f39`, (res) => {
          res.resume();
          res.on('end', () => resolve(res));
        }).on('error', reject);
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['cache-control']).toBe('no-cache');
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
