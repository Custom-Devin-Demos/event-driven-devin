const tracer = require('dd-trace');
const StatsD = require('hot-shots');

let dogstatsd = null;

function initDatadog() {
  const env = process.env.DD_ENV || 'demo';
  const service = process.env.DD_SERVICE || 'checkout-api';
  const version = process.env.DD_VERSION || process.env.APP_VERSION || '1.0.0';

  tracer.init({
    env,
    service,
    version,
    logInjection: true,
    runtimeMetrics: true,
    hostname: process.env.DD_AGENT_HOST || 'localhost',
    port: parseInt(process.env.DD_TRACE_AGENT_PORT, 10) || 8126,
  });

  dogstatsd = new StatsD({
    host: process.env.DD_AGENT_HOST || 'localhost',
    port: parseInt(process.env.DD_DOGSTATSD_PORT, 10) || 8125,
    prefix: 'demo.',
    globalTags: {
      env,
      service,
      version,
      scenario: process.env.APP_SCENARIO || 'healthy',
    },
    errorHandler(error) {
      console.warn('[dogstatsd] Error:', error.message);
    },
  });

  console.log('[datadog] Initialized', { env, service, version });
}

function getStatsClient() {
  return dogstatsd;
}

function recordMetric(name, value, tags) {
  if (dogstatsd) {
    dogstatsd.gauge(name, value, tags);
  }
}

function incrementMetric(name, tags) {
  if (dogstatsd) {
    dogstatsd.increment(name, 1, tags);
  }
}

function recordTiming(name, value, tags) {
  if (dogstatsd) {
    dogstatsd.timing(name, value, tags);
  }
}

module.exports = {
  tracer,
  initDatadog,
  getStatsClient,
  recordMetric,
  incrementMetric,
  recordTiming,
};
