// Initialize Datadog tracer BEFORE any other imports (required by dd-trace)
const { initDatadog } = require('./telemetry/datadog');
initDatadog();

const express = require('express');
const { initSentry, Sentry } = require('./telemetry/sentry');
const logger = require('./telemetry/logger');
const { getScenario, runWithOncallRun } = require('./incidentModes');
const { v4: uuidv4 } = require('uuid');

// Initialize Sentry
initSentry();

// Routes
const healthRoutes = require('./routes/health');
const loginRoutes = require('./routes/login');
const searchRoutes = require('./routes/search');
const checkoutRoutes = require('./routes/checkout');
const ordersRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhook');
const storefrontRoutes = require('./routes/storefront');
const sentryWebhookRoutes = require('./routes/sentry-webhook');
const devinUsersRoutes = require('./routes/devin-users');
const verticalRoutes = require('./routes/verticals');
const webinarRoutes = require('./routes/webinar');
const oncallRoutes = require('./routes/oncall');
const { runWithLegacyAlertsSuppressed } = require('./services/oncall-suppression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static assets (CSS, JS, images) but NOT index.html at root
// The hub landing page is served by the verticals router at /
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Middleware: parse JSON (capture raw body for webhook signature verification)
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Middleware: on-call mode — run the real code path (Sentry/Datadog telemetry
// fires normally) but suppress the legacy Slack-alert/Devin trigger; the
// on-call responders are driven by the alert card posted to the on-call channels.
app.use((req, _res, next) => {
  if (req.headers['x-oncall-mode'] === '1') {
    return runWithLegacyAlertsSuppressed(() => next());
  }
  next();
});

// Middleware: per-run On-Call degradation scoping — requests carrying an
// oncall_run cookie see that run's live degradation; all other traffic is
// unaffected.
app.use((req, _res, next) => {
  const match = /(?:^|;\s*)oncall_run=([A-Za-z0-9-]+)/.exec(req.headers.cookie || '');
  if (match) {
    return runWithOncallRun(match[1], () => next());
  }
  next();
});

// Middleware: request ID and logging
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('x-request-id', req.requestId);

  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('Request completed', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      scenario: getScenario(),
      userAgent: req.headers['user-agent'],
      persona: req.query.persona || req.body?.persona || 'unknown',
    });
  });

  next();
});

// Mount routes
app.use(healthRoutes);
app.use(loginRoutes);
app.use(searchRoutes);
app.use(checkoutRoutes);
app.use(ordersRoutes);
app.use(adminRoutes);
app.use(webhookRoutes);
app.use(storefrontRoutes);
app.use(sentryWebhookRoutes);
app.use(devinUsersRoutes);
app.use(webinarRoutes);
app.use(oncallRoutes);
app.use(verticalRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    method: req.method,
  });
});

// Global error handler
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    requestId: req.requestId,
    path: req.path,
    method: req.method,
  });

  Sentry.captureException(err);

  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    requestId: req.requestId,
  });
});

// Start server
const server = app.listen(PORT, () => {
  logger.info('Acme Commerce API started', {
    port: PORT,
    version: process.env.DD_VERSION || process.env.APP_VERSION || '1.0.0',
    environment: process.env.DD_ENV || 'prod',
    scenario: getScenario(),
    service: process.env.DD_SERVICE || 'checkout-api',
  });
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║       Acme Commerce - Checkout API           ║
  ║                                              ║
  ║  Port:        ${String(PORT).padEnd(30)}║
  ║  Version:     ${(process.env.DD_VERSION || process.env.APP_VERSION || '1.0.0').padEnd(30)}║
  ║  Environment: ${(process.env.DD_ENV || 'prod').padEnd(30)}║
  ║  Scenario:    ${getScenario().padEnd(30)}║
  ║                                              ║
  ║  Endpoints:                                  ║
  ║    GET  /health                               ║
  ║    POST /login                                ║
  ║    GET  /search?q=...                         ║
  ║    POST /checkout                             ║
  ║    GET  /orders/:id                           ║
  ║    GET  /admin/scenario                       ║
  ║    POST /admin/scenario                       ║
  ║    POST /webhook/github                        ║
  ║    POST /webhooks/sentry                        ║
  ║                                              ║
  ║  Verticals:                                  ║
  ║    /retail              eCommerce            ║
  ║    /banking             Apex Bank            ║
  ║    /financial-services  Meridian Capital      ║
  ║    /insurance           Shield Insurance     ║
  ║    /cpg                 Harvest Goods        ║
  ║    /hightech            NovaSoft             ║
  ║    /industrials         Titan Manufacturing  ║
  ║    /healthcare          CarePoint Health     ║
  ║    /telco               WaveConnect          ║
  ╚══════════════════════════════════════════════╝
  `);
});

// ── Graceful shutdown (zero-downtime deploys) ────────────────────
// When Docker sends SIGTERM, stop accepting new connections and let
// in-flight requests finish before the process exits.
function gracefulShutdown(signal) {
  logger.info(`${signal} received — draining connections`, {
    service: process.env.DD_SERVICE || 'checkout-api',
  });

  server.close(() => {
    logger.info('All connections drained — exiting');
    process.exit(0);
  });

  // Force exit if draining takes longer than 10s (Docker stop_grace_period is 15s)
  setTimeout(() => {
    logger.warn('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
