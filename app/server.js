// Initialize Datadog tracer BEFORE any other imports (required by dd-trace)
const { initDatadog } = require('./telemetry/datadog');
initDatadog();

const express = require('express');
const { initSentry, Sentry } = require('./telemetry/sentry');
const logger = require('./telemetry/logger');
const { getScenario } = require('./incidentModes');
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

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware: parse JSON (capture raw body for webhook signature verification)
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

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
app.listen(PORT, () => {
  logger.info('Acme Commerce API started', {
    port: PORT,
    version: process.env.DD_VERSION || process.env.APP_VERSION || '1.0.0',
    environment: process.env.DD_ENV || 'demo',
    scenario: getScenario(),
    service: process.env.DD_SERVICE || 'checkout-api',
  });
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║       Acme Commerce - Checkout API           ║
  ║                                              ║
  ║  Port:        ${String(PORT).padEnd(30)}║
  ║  Version:     ${(process.env.DD_VERSION || process.env.APP_VERSION || '1.0.0').padEnd(30)}║
  ║  Environment: ${(process.env.DD_ENV || 'demo').padEnd(30)}║
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
  ╚══════════════════════════════════════════════╝
  `);
});

module.exports = app;
