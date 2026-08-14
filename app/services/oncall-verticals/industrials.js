const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const {
  quoteAtEdge,
  startGateway,
  recordCertificateExpiryMetric,
  SITE_CERT_NAMES,
} = require('./industrials-edge');

const FACTORY_NAMES = {
  'f2-torrance': 'F2 Torrance',
  'f3-mesa': 'F3 Mesa',
  'f4-alabama': 'F4 Alabama',
};

const ROUTE = '/api/oncall/industrials/quote';

/**
 * Edge gateway submission policy — the client cert loader intentionally
 * presents the configured leaf for each site without checking its expiry.
 */
const GATEWAY_RETRY_POLICY = {
  maxAttempts: 3,
  timeoutMs: 4000,
  backoffMs: 750,
};

const CLOUD_DFM_STAGES = [
  ['queueDepthMs', 4900],
  ['geometryMs', 2600],
  ['toleranceMs', 2500],
  ['materialMs', 1900],
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCloudDfm(quote, options) {
  const stages = {};
  for (const [name, duration] of CLOUD_DFM_STAGES) {
    const started = Date.now();
    await wait(duration);
    stages[name] = Date.now() - started;
    logger.info('Cloud DFM quote stage completed', {
      service: 'quote-api',
      site: quote.site,
      stage: name,
      durationMs: stages[name],
    });
  }
  if (options.debugTimings) {
    logger.info('Cloud DFM quote stage timings', {
      service: 'quote-api',
      site: quote.site,
      stepTimings: stages,
    });
  }
  return stages;
}

async function submitToEdge(quote, options) {
  let lastError;
  const started = Date.now();
  const attempts = [];
  for (let attempt = 1; attempt <= GATEWAY_RETRY_POLICY.maxAttempts; attempt += 1) {
    const attemptStarted = Date.now();
    try {
      const result = await quoteAtEdge(quote.site, quote, GATEWAY_RETRY_POLICY.timeoutMs);
      attempts.push({ attempt, durationMs: Date.now() - attemptStarted, status: 'success' });
      return {
        result,
        attempts,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      lastError = error;
      attempts.push({
        attempt,
        durationMs: Date.now() - attemptStarted,
        code: error.code,
        error: error.message,
        status: 'rejected',
      });
      logger.warn('Industrial edge quote attempt failed, retrying', {
        service: 'quote-api',
        site: quote.site,
        attempt,
        maxAttempts: GATEWAY_RETRY_POLICY.maxAttempts,
        code: error.code,
        error: error.message,
      });
      if (attempt < GATEWAY_RETRY_POLICY.maxAttempts) {
        await wait(GATEWAY_RETRY_POLICY.backoffMs * (2 ** (attempt - 1)));
      }
    }
  }
  const durationMs = Date.now() - started;
  if (options.debugTimings) {
    logger.info('Industrial edge quote retry phase completed', {
      service: 'quote-api',
      site: quote.site,
      durationMs,
      attempts,
    });
  }
  const exhausted = new Error(lastError?.message || 'Industrial edge gateway rejected the quote');
  exhausted.code = lastError?.code || 'EDGE_GATEWAY_REJECTED';
  exhausted.attempts = attempts;
  exhausted.durationMs = durationMs;
  throw exhausted;
}

function quoteId() {
  return `QT-${uuidv4().slice(0, 8).toUpperCase()}`;
}

async function processQuote(data, options = {}) {
  const quote = {
    quoteId: quoteId(),
    partNumber: data.partNumber || 'TM-DFM-4400',
    material: data.material || '7075-T6 Aluminum',
    toleranceClass: data.toleranceClass || 'Class B',
    quantity: Number(data.quantity) || 25,
    itarControlled: Boolean(data.itarControlled),
    site: SITE_CERT_NAMES.includes(data.site)
      ? data.site
      : 'f3-mesa',
  };
  logger.info('Processing instant quote', {
    quoteId: quote.quoteId,
    partNumber: quote.partNumber,
    quantity: quote.quantity,
    site: quote.site,
    service: 'quote-api',
    route: ROUTE,
  });

  let startTime;
  try {
    await startGateway();
    startTime = Date.now();
    recordCertificateExpiryMetric(quote.site);
    const edgeStarted = Date.now();
    let edge;
    let fallback = false;
    try {
      edge = await submitToEdge(quote, options);
    } catch (error) {
      fallback = true;
      edge = {
        attempts: error.attempts || [],
        durationMs: error.durationMs || (Date.now() - edgeStarted),
        errorCode: error.code,
        errorMessage: error.message,
      };
      logger.warn('Industrial edge quote falling back to cloud DFM', {
        service: 'quote-api',
        site: quote.site,
        code: error.code,
        error: error.message,
        durationMs: edge.durationMs,
      });
    }

    const queueStarted = Date.now();
    const cloudStages = fallback ? await runCloudDfm(quote, options) : null;
    const queueDurationMs = fallback ? Date.now() - queueStarted : 0;
    const totalDurationMs = Date.now() - startTime;
    const phaseTimings = {
      edgeAttemptMs: edge.durationMs,
      cloudQueueMs: queueDurationMs,
      totalMs: totalDurationMs,
    };

    const tags = { route: ROUTE, site: quote.site };
    recordTiming('quote.edge_attempt_phase', phaseTimings.edgeAttemptMs, tags);
    recordTiming('quote.cloud_queue_phase', phaseTimings.cloudQueueMs, tags);
    recordTiming('quote.total', phaseTimings.totalMs, tags);
    incrementMetric('quote.success', tags);
    recordTiming('quote.latency', totalDurationMs, tags);
    logger.info('Instant quote completed', {
      quoteId: quote.quoteId,
      site: quote.site,
      durationMs: totalDurationMs,
      service: 'quote-api',
      phaseTimings,
      ...(options.debugTimings ? { edgeAttempts: edge.attempts, cloudStages } : {}),
    });

    return {
      success: true,
      quoteId: quote.quoteId,
      status: 'ready',
      site: quote.site,
      factory: FACTORY_NAMES[quote.site],
      estimate: {
        leadTimeDays: fallback ? 18 : 12,
        price: 12840 + quote.quantity * 38,
        currency: 'USD',
      },
      ...(options.debugTimings ? { phaseTimings, fallback } : {}),
    };
  } catch (error) {
    const durationMs = startTime ? Date.now() - startTime : 0;
    incrementMetric('quote.failure', {
      route: ROUTE,
      site: quote.site,
      errorClass: error.name,
    });
    recordTiming('quote.latency', durationMs, {
      route: ROUTE,
      site: quote.site,
      error: 'true',
    });
    logger.error('Instant quote failed', {
      quoteId: quote.quoteId,
      site: quote.site,
      durationMs,
      error: error.message,
      errorClass: error.name,
      service: 'quote-api',
    });
    Sentry.captureException(error, {
      tags: { route: ROUTE, service: 'quote-api', site: quote.site },
      extra: { quoteId: quote.quoteId },
    });
    throw error;
  }
}

module.exports = {
  GATEWAY_RETRY_POLICY,
  processQuote,
};
