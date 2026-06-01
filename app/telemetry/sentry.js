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

// Extract the route path from a Sentry transaction name, which is typically
// "GET /health" or sometimes just "/health". Strips the HTTP method prefix and
// any query string so patterns are matched against the path alone.
function transactionPath(name) {
  const parts = name.trim().split(/\s+/);
  const raw = parts.length > 1 ? parts[parts.length - 1] : name;
  return raw.split('?')[0];
}

function isUntracedTransaction(name) {
  const path = transactionPath(name);
  // Boundary-aware match: exact path or a sub-path segment, so '/health' does
  // NOT match '/healthcare' or '/api/healthcare/...' (a real vertical).
  return UNTRACED_TRANSACTION_PATTERNS.some(
    (pattern) => path === pattern || path.startsWith(`${pattern}/`),
  );
}

function makeTracesSampler(defaultRate) {
  return (samplingContext) => {
    const name = (samplingContext && samplingContext.name) || '';
    if (isUntracedTransaction(name)) {
      return 0;
    }
    return defaultRate;
  };
}

// Framework-internal child spans (one per Express router/middleware layer the
// request walks) that add little APM value but dominate span volume — a single
// traced request through the 9 mounted vertical routers emits ~100+ of them.
// Ignoring them keeps the root request transaction plus the meaningful spans
// (db, outbound http.client) while cutting the bulk of span volume. Error
// capture and the Slack/Devin alert pipeline are unaffected (they are not spans).
//
// This uses Sentry's `ignoreSpans` option, NOT `beforeSendSpan`. In @sentry/node
// v10 a `beforeSendSpan` that returns null does NOT drop a child span — the SDK
// logs a warning and keeps the span. `ignoreSpans` actually drops the matched
// span and reparents its children. A matched *root* span would drop the whole
// transaction, but our matched ops are framework child ops (router/middleware),
// never the `http.server` root, so request-level tracing is preserved.
const DROPPED_SPAN_OPS = (process.env.SENTRY_DROPPED_SPAN_OPS ?? 'router.express,middleware.express')
  .split(',')
  .map((op) => op.trim())
  .filter(Boolean);

const IGNORED_SPANS = DROPPED_SPAN_OPS.map((op) => ({ op }));

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
    ignoreSpans: IGNORED_SPANS,
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
