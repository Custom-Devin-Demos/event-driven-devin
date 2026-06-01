const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

// High-frequency, low-value transactions (UI polling, health checks, config)
// that otherwise dominate span volume. These are dropped from tracing entirely
// via tracesSampler, regardless of any inbound trace-sampling decision. Error
// capture and the Slack/Devin alert pipeline are unaffected.
const UNTRACED_TRANSACTION_PATTERNS = [
  '/api/admin/session-stats',
  '/api/config',
  '/health',
];

function makeTracesSampler(defaultRate) {
  return (samplingContext) => {
    const name = (samplingContext && samplingContext.name) || '';
    if (UNTRACED_TRANSACTION_PATTERNS.some((pattern) => name.includes(pattern))) {
      return 0;
    }
    return defaultRate;
  };
}

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.warn('[sentry] SENTRY_DSN not set — Sentry disabled');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.DD_ENV || 'prod',
    release: process.env.SENTRY_RELEASE || `acme-checkout@${process.env.APP_VERSION || '1.0.0'}`,
    integrations: (defaults) => [
      ...defaults.filter((i) => i.name !== 'Dedupe'),
      nodeProfilingIntegration(),
    ],
    tracesSampler: makeTracesSampler(Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1)),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? 0.1),
    beforeSend(event) {
      const { getScenario } = require('../incidentModes');
      event.tags = {
        scenario: getScenario(),
        tenant: 'synthetic',
        customer: 'acme-demo',
        service: process.env.DD_SERVICE || 'checkout-api',
        ...event.tags,
      };
      return event;
    },
  });

  console.log('[sentry] Initialized', {
    environment: process.env.SENTRY_ENVIRONMENT || 'prod',
    release: process.env.SENTRY_RELEASE || `acme-checkout@${process.env.APP_VERSION || '1.0.0'}`,
  });
}

module.exports = { initSentry, Sentry };
