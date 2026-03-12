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
    environment: process.env.SENTRY_ENVIRONMENT || process.env.DD_ENV || 'demo',
    release: process.env.SENTRY_RELEASE || `acme-checkout@${process.env.APP_VERSION || '1.0.0'}`,
    integrations: [
      nodeProfilingIntegration(),
    ],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
    beforeSend(event) {
      event.tags = {
        ...event.tags,
        scenario: process.env.APP_SCENARIO || 'healthy',
        tenant: 'synthetic',
        customer: 'acme-demo',
        service: process.env.DD_SERVICE || 'checkout-api',
      };
      return event;
    },
  });

  console.log('[sentry] Initialized', {
    environment: process.env.SENTRY_ENVIRONMENT || 'demo',
    release: process.env.SENTRY_RELEASE || `acme-checkout@${process.env.APP_VERSION || '1.0.0'}`,
  });
}

module.exports = { initSentry, Sentry };
