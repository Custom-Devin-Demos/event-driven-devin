const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

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
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
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
