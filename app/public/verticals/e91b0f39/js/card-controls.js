/* global window, AbortController, URLSearchParams, navigator */
(function attachCardControls(root, factory) {
  const cardControls = factory();
  if (typeof module === 'object' && module.exports) module.exports = cardControls;
  if (root) root.CardControls = cardControls;
})(typeof window !== 'undefined' ? window : globalThis, function createCardControlsModule() {
  const LATENCY = Object.freeze({
    recurringMerchants: 150,
    merchantStatus: 265,
    merchantStatuses: 300,
    lock: 300,
    unlock: 300,
  });
  const LOCK_TIMEOUT_MS = 5000;
  const SLO_MS = 3000;
  const TIMEOUT_MESSAGE = 'Something went wrong. Request timed out';
  const ERROR_BUBBLE_CLASS = 'erica-bubble--error';
  const CARD = Object.freeze({
    id: 'dc-4417',
    last4: '4417',
    type: 'debit',
    productName: 'Adv Plus Banking',
  });
  const SEED_MERCHANTS = Object.freeze([
    'Netflix',
    'Spotify',
    'Hulu',
    'Disney+',
    'Max',
    'Peacock',
    'Paramount+',
    'YouTube Premium',
    'Apple iCloud+',
    'Amazon Prime',
    'Audible',
    'Microsoft 365',
    'Adobe Creative Cloud',
    'Dropbox',
    'Google One',
    'Xfinity Internet',
    'Verizon Wireless',
    'Duke Energy',
    'Charlotte Water',
    'Piedmont Natural Gas',
    'State Farm Insurance',
    'GEICO',
    'Planet Fitness',
    'Peloton',
    'The New York Times',
    'The Wall Street Journal',
    'Patreon',
    'DoorDash DashPass',
    'Uber One',
    'Instacart+',
    'Chewy Autoship',
    'HelloFresh',
    'Dollar Shave Club',
    'SiriusXM',
    'LinkedIn Premium',
    'ADT Security',
    'Ring Protect',
    'Norton 360',
  ].map((name, index) => Object.freeze({
    id: `m-${String(index + 1).padStart(3, '0')}`,
    name,
  })));

  function createSystemClock() {
    return {
      now: () => Date.now(),
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
    };
  }

  function abortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
  }

  function createFakeTransport({
    clock,
    latency = LATENCY,
    merchants = { [CARD.id]: SEED_MERCHANTS },
  }) {
    const log = [];
    let lockReference = 0;
    let unlockReference = 0;

    function latencyFor(method, path) {
      if (method === 'GET' && path.endsWith('/recurring-merchants')) return latency.recurringMerchants;
      if (method === 'GET' && path.endsWith('/status')) return latency.merchantStatus;
      if (method === 'POST' && path.endsWith('/statuses')) return latency.merchantStatuses;
      if (method === 'POST' && path.endsWith('/lock')) return latency.lock;
      if (method === 'POST' && path.endsWith('/unlock')) return latency.unlock;
      return 0;
    }

    function responseFor(method, path, body) {
      const recurringMerchantsMatch = path.match(/^\/card-controls\/cards\/([^/]+)\/recurring-merchants$/);
      if (method === 'GET' && recurringMerchantsMatch) {
        return { merchants: merchants[recurringMerchantsMatch[1]] || [] };
      }

      const merchantStatusMatch = path.match(/^\/card-controls\/cards\/([^/]+)\/recurring-merchants\/([^/]+)\/status$/);
      if (method === 'GET' && merchantStatusMatch) {
        return { merchantId: merchantStatusMatch[2], isAuthorized: true };
      }

      if (method === 'POST' && path.match(/^\/card-controls\/cards\/[^/]+\/recurring-merchants\/statuses$/)) {
        return {
          statuses: (body.merchantIds || []).map((merchantId) => ({ merchantId, isAuthorized: true })),
        };
      }

      const lockMatch = path.match(/^\/card-controls\/cards\/([^/]+)\/lock$/);
      if (method === 'POST' && lockMatch) {
        lockReference += 1;
        return {
          cardId: lockMatch[1],
          lockedAt: new Date(clock.now()).toISOString(),
          reference: `LK-${String(lockReference).padStart(6, '0')}`,
        };
      }

      const unlockMatch = path.match(/^\/card-controls\/cards\/([^/]+)\/unlock$/);
      if (method === 'POST' && unlockMatch) {
        unlockReference += 1;
        return {
          cardId: unlockMatch[1],
          lockedAt: new Date(clock.now()).toISOString(),
          reference: `UL-${String(unlockReference).padStart(6, '0')}`,
        };
      }

      throw new Error(`Unsupported card-controls request: ${method} ${path}`);
    }

    return {
      log,
      request(method, path, body = {}, { signal } = {}) {
        if (signal && signal.aborted) return Promise.reject(abortError());

        log.push({ method, path, startedAt: clock.now() });
        const delay = latencyFor(method, path);

        return new Promise((resolve, reject) => {
          let timer;
          const cleanUp = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
          };
          const onAbort = () => {
            clock.clearTimeout(timer);
            cleanUp();
            reject(abortError());
          };

          if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) {
              cleanUp();
              reject(abortError());
              return;
            }
          }

          timer = clock.setTimeout(() => {
            cleanUp();
            try {
              resolve(responseFor(method, path, body));
            } catch (error) {
              reject(error);
            }
          }, delay);
        });
      },
    };
  }

  function createMetrics() {
    let requestCount = 0;
    const spans = [];

    return {
      record(spanName, durationMs) {
        requestCount += 1;
        const existing = spans.find((span) => span.name === spanName);
        if (existing) {
          existing.count += 1;
          existing.totalMs += durationMs;
        } else {
          spans.push({ name: spanName, count: 1, totalMs: durationMs });
        }
      },
      snapshot() {
        return {
          requestCount,
          spans: spans.map((span) => ({ ...span })),
        };
      },
      reset() {
        requestCount = 0;
        spans.length = 0;
      },
    };
  }

  class CardControlsAPI {
    constructor({ transport, clock, metrics }) {
      this.transport = transport;
      this.clock = clock;
      this.metrics = metrics;
    }

    async request(spanName, method, path, body = {}, opts = {}) {
      const { signal } = opts;
      if (signal && signal.aborted) throw abortError();

      const startedAt = this.clock.now();
      try {
        return await this.transport.request(method, path, body, { signal });
      } finally {
        this.metrics.record(spanName, this.clock.now() - startedAt);
      }
    }

    recurringMerchants(cardId, opts = {}) {
      return this.request(
        'card_controls.recurring_merchants',
        'GET',
        `/card-controls/cards/${cardId}/recurring-merchants`,
        {},
        opts,
      ).then((result) => result.merchants);
    }

    merchantStatus(cardId, merchantId, opts = {}) {
      return this.request(
        'card_controls.merchant_status',
        'GET',
        `/card-controls/cards/${cardId}/recurring-merchants/${merchantId}/status`,
        {},
        opts,
      );
    }

    merchantStatuses(cardId, merchantIds, opts = {}) {
      return this.request(
        'card_controls.merchant_statuses',
        'POST',
        `/card-controls/cards/${cardId}/recurring-merchants/statuses`,
        { merchantIds },
        opts,
      ).then((result) => result.statuses);
    }

    lock(cardId, opts = {}) {
      return this.request(
        'card_controls.lock',
        'POST',
        `/card-controls/cards/${cardId}/lock`,
        {},
        opts,
      );
    }

    unlock(cardId, opts = {}) {
      return this.request(
        'card_controls.unlock',
        'POST',
        `/card-controls/cards/${cardId}/unlock`,
        {},
        opts,
      );
    }
  }

  class RecurringPaymentAuthorizationError extends Error {
    constructor(merchantId) {
      super(`Recurring payment authorization failed for ${merchantId}`);
      this.name = 'RecurringPaymentAuthorizationError';
      this.merchantId = merchantId;
    }
  }

  class RecurringPaymentsGuard {
    constructor({ api }) {
      this.api = api;
    }

    async preflight(card, merchants, opts = {}) {
      const statuses = [];
      for (const merchant of merchants) {
        const status = await this.api.merchantStatus(card.id, merchant.id, opts);
        if (!status.isAuthorized) throw new RecurringPaymentAuthorizationError(merchant.id);
        statuses.push(status);
      }
      return statuses;
    }
  }

  class CardLockService {
    constructor({ api, guard }) {
      this.api = api;
      this.guard = guard;
    }

    async lockWithMerchantCount(card, opts = {}, onMerchantsFetched = () => {}) {
      const merchants = await this.api.recurringMerchants(card.id, opts);
      onMerchantsFetched(merchants.length);
      await this.guard.preflight(card, merchants, opts);
      const confirmation = await this.api.lock(card.id, opts);
      return { confirmation, merchantCount: merchants.length };
    }

    unlock(card, opts = {}) {
      return this.api.unlock(card.id, opts);
    }
  }

  class CardLockTimeoutError extends Error {
    constructor(measurement) {
      super(TIMEOUT_MESSAGE);
      this.name = 'CardLockTimeoutError';
      this.measurement = measurement;
    }
  }

  function lockFailureMessage(error) {
    if (error && error.name === 'CardLockTimeoutError') {
      return {
        text: TIMEOUT_MESSAGE,
        variant: 'error',
        className: ERROR_BUBBLE_CLASS,
      };
    }
    return {
      text: "Sorry, I couldn't lock your card right now. Please try again.",
      variant: 'default',
      className: '',
    };
  }

  function spanDeltas(before, after) {
    const previousByName = new Map(before.spans.map((span) => [span.name, span]));
    return after.spans.flatMap((span) => {
      const previous = previousByName.get(span.name);
      const count = span.count - (previous ? previous.count : 0);
      if (count <= 0) return [];
      return [{
        name: span.name,
        count,
        totalMs: span.totalMs - (previous ? previous.totalMs : 0),
      }];
    });
  }

  function createReportId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const value = Math.floor(Math.random() * 16);
      return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
    });
  }

  class LockTelemetry {
    constructor({
      service,
      metrics,
      clock,
      reporter,
      timeoutMs = LOCK_TIMEOUT_MS,
      makeReportId = createReportId,
    }) {
      this.service = service;
      this.metrics = metrics;
      this.clock = clock;
      this.reporter = reporter;
      this.timeoutMs = timeoutMs;
      this.makeReportId = makeReportId;
      this.lastReportDelivery = undefined;
    }

    measurementFor(reportId, startedAt, before, merchantCount, outcome, timedOut) {
      const after = this.metrics.snapshot();
      const elapsed = this.clock.now() - startedAt;
      return {
        reportId,
        durationMs: timedOut ? Math.min(this.timeoutMs, elapsed) : elapsed,
        requestCount: after.requestCount - before.requestCount,
        merchantCount,
        spans: spanDeltas(before, after),
        outcome,
      };
    }

    deliverReport(measurement, card) {
      this.lastReportDelivery = Promise.resolve()
        .then(() => this.reporter.reportLockLatency(measurement, card))
        .catch(() => undefined);
    }

    async lock(card) {
      const reportId = this.makeReportId();
      const before = this.metrics.snapshot();
      const startedAt = this.clock.now();
      const controller = new AbortController();
      let timedOut = false;
      let merchantCount = 0;
      const deadline = this.clock.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);

      try {
        const result = await this.service.lockWithMerchantCount(
          card,
          { signal: controller.signal },
          (count) => { merchantCount = count; },
        );
        merchantCount = result.merchantCount;
        const measurement = this.measurementFor(
          reportId,
          startedAt,
          before,
          merchantCount,
          'locked',
          false,
        );
        if (measurement.durationMs > SLO_MS) this.deliverReport(measurement, card);
        return { confirmation: result.confirmation, measurement };
      } catch (error) {
        if (!timedOut) throw error;
        const measurement = this.measurementFor(
          reportId,
          startedAt,
          before,
          merchantCount,
          'timeout',
          true,
        );
        this.deliverReport(measurement, card);
        throw new CardLockTimeoutError(measurement);
      } finally {
        this.clock.clearTimeout(deadline);
      }
    }

    unlock(card) {
      return this.service.unlock(card);
    }
  }

  function parseUserAgent(userAgent) {
    const ua = String(userAgent || '');
    let os = 'Unknown';
    let osVersion = 'Unknown';

    const iosMatch = ua.match(/(?:iPhone|iPad|iPod).*?OS ([\d_]+)/i);
    const androidMatch = ua.match(/Android(?:\s([\d.]+))?/i);
    const chromeOsMatch = ua.match(/CrOS [^ ]+ ([\d.]+)/i);
    const windowsMatch = ua.match(/Windows NT ([\d.]+)/i);
    const macMatch = ua.match(/Mac OS X ([\d_.]+)/i);

    if (iosMatch) {
      os = 'iOS';
      osVersion = `iOS ${iosMatch[1].replace(/_/g, '.')}`;
    } else if (androidMatch) {
      os = 'Android';
      osVersion = androidMatch[1] ? `Android ${androidMatch[1]}` : 'Android';
    } else if (chromeOsMatch) {
      os = 'ChromeOS';
      osVersion = `ChromeOS ${chromeOsMatch[1]}`;
    } else if (windowsMatch) {
      os = 'Windows';
      const windowsVersion = {
        '10.0': '10',
        '6.3': '8.1',
        '6.2': '8',
        '6.1': '7',
      }[windowsMatch[1]] || windowsMatch[1];
      osVersion = `Windows ${windowsVersion}`;
    } else if (macMatch) {
      os = 'macOS';
      osVersion = `macOS ${macMatch[1].replace(/_/g, '.')}`;
    } else if (/Linux/i.test(ua)) {
      os = 'Linux';
      osVersion = 'Linux';
    }

    let browser;
    let browserVersion;
    const browsers = [
      ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/i],
      ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/i],
      ['Firefox', /Firefox\/([\d.]+)/i],
      ['Safari', /Version\/([\d.]+).*Safari/i],
    ];
    for (const [name, pattern] of browsers) {
      const match = ua.match(pattern);
      if (match) {
        browser = name;
        browserVersion = Number.parseInt(match[1], 10);
        break;
      }
    }

    if (!browser || !Number.isFinite(browserVersion)) {
      return { device: 'Browser / Unknown', osVersion: 'Unknown' };
    }
    const deviceOs = os === 'Unknown' ? 'Unknown' : os;
    return {
      device: `${browser} ${browserVersion} / ${deviceOs}`.slice(0, 40),
      osVersion: osVersion.slice(0, 20),
    };
  }

  function buildLockLatencyReport(measurement, card, {
    release = 'card-controls-web@1.0.0',
    device,
    osVersion,
    ownerEmail,
  } = {}) {
    const report = {
      reportId: measurement.reportId,
      source: 'card-controls-web/desktop',
      service: 'card-controls-web',
      platform: 'web',
      release,
      screen: 'erica',
      action: 'lock_card',
      cardLast4: card.last4,
      cardType: card.type,
      durationMs: measurement.durationMs,
      sloMs: SLO_MS,
      requestCount: measurement.requestCount,
      merchantCount: measurement.merchantCount,
      spans: measurement.spans.slice(0, 6),
      device,
      osVersion,
      outcome: measurement.outcome,
    };
    if (typeof ownerEmail === 'string' && ownerEmail.trim()) report.devinEmail = ownerEmail;
    return report;
  }

  function reportsEnabledFromSearch(search) {
    const query = String(search || '').replace(/^\?/, '');
    return new URLSearchParams(query).get('reports') !== 'off';
  }

  function createLockLatencyReporter({
    enabled,
    url = '/api/oncall/e91b0f39/lock-latency',
    fetchImpl,
    userAgent,
    ownerEmail,
    log = console.info,
  }) {
    return {
      async reportLockLatency(measurement, card) {
        if (!enabled) {
          log('[card-controls] report suppressed');
          return;
        }

        try {
          const agent = userAgent === undefined
            ? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
            : userAgent;
          const parsedAgent = parseUserAgent(agent);
          const payload = buildLockLatencyReport(measurement, card, {
            device: parsedAgent.device,
            osVersion: parsedAgent.osVersion,
            ownerEmail,
          });
          const send = fetchImpl || ((...args) => globalThis.fetch(...args));
          const response = await send(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          let acknowledgement = {};
          try {
            acknowledgement = await response.json();
          } catch {
            acknowledgement = {};
          }
          log(`[card-controls] report status=${response.status} reference=${acknowledgement.reference || 'unavailable'}`);
        } catch (error) {
          log(`[card-controls] report failed ${error.message || ''}`);
        }
      },
    };
  }

  function createCardControls({
    clock = createSystemClock(),
    transport,
    reportsEnabled = false,
    fetchImpl,
    userAgent,
    ownerEmail,
    timeoutMs = LOCK_TIMEOUT_MS,
    reporter,
  } = {}) {
    const actualTransport = transport || createFakeTransport({ clock });
    const metrics = createMetrics();
    const api = new CardControlsAPI({ transport: actualTransport, clock, metrics });
    const guard = new RecurringPaymentsGuard({ api });
    const service = new CardLockService({ api, guard });
    const actualReporter = reporter || createLockLatencyReporter({
      enabled: reportsEnabled,
      fetchImpl,
      userAgent,
      ownerEmail,
    });
    const telemetry = new LockTelemetry({
      service,
      metrics,
      clock,
      reporter: actualReporter,
      timeoutMs,
    });

    return {
      lock: (card) => telemetry.lock(card),
      unlock: (card) => telemetry.unlock(card),
      telemetry,
      api,
      transport: actualTransport,
      metrics,
    };
  }

  return {
    LATENCY,
    LOCK_TIMEOUT_MS,
    SLO_MS,
    TIMEOUT_MESSAGE,
    ERROR_BUBBLE_CLASS,
    CARD,
    SEED_MERCHANTS,
    createSystemClock,
    createFakeTransport,
    createMetrics,
    CardControlsAPI,
    RecurringPaymentAuthorizationError,
    RecurringPaymentsGuard,
    CardLockService,
    CardLockTimeoutError,
    lockFailureMessage,
    LockTelemetry,
    parseUserAgent,
    buildLockLatencyReport,
    reportsEnabledFromSearch,
    createLockLatencyReporter,
    createCardControls,
  };
});
