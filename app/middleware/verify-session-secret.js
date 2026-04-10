const crypto = require('crypto');
const logger = require('../telemetry/logger');

/**
 * Middleware that verifies a shared session secret on requests that
 * trigger Devin session creation.
 *
 * When SESSION_SECRET is set, incoming requests must provide the secret
 * via one of:
 *   - `x-session-secret` header
 *   - `sessionSecret` query parameter
 *
 * When SESSION_SECRET is NOT set, this middleware is a no-op (pass-through)
 * to maintain backward compatibility.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifySessionSecret(req, res, next) {
  const expectedSecret = process.env.SESSION_SECRET;

  // If no secret is configured, skip verification (backward-compat)
  if (!expectedSecret) {
    return next();
  }

  const providedSecret = req.headers['x-session-secret']
    || req.query.sessionSecret
    || '';

  if (!providedSecret) {
    logger.warn('Session secret missing — request rejected', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Session secret required' });
  }

  // Timing-safe comparison to prevent timing attacks
  const expected = Buffer.from(expectedSecret, 'utf8');
  const provided = Buffer.from(String(providedSecret), 'utf8');

  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    logger.warn('Session secret invalid — request rejected', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(403).json({ error: 'Invalid session secret' });
  }

  return next();
}

/**
 * Verify a Sentry webhook signature using HMAC-SHA256.
 *
 * When SENTRY_CLIENT_SECRET is set, the middleware validates the
 * `sentry-hook-signature` header against the raw request body.
 * Sentry signs webhooks with HMAC-SHA256 using the client secret
 * from the Sentry integration settings.
 *
 * When SENTRY_CLIENT_SECRET is NOT set, this middleware is a no-op.
 */
function verifySentrySignature(req, res, next) {
  const clientSecret = process.env.SENTRY_CLIENT_SECRET;

  // If no client secret is configured, skip verification
  if (!clientSecret) {
    return next();
  }

  const signature = req.headers['sentry-hook-signature'];
  if (!signature) {
    logger.warn('Sentry webhook signature missing — request rejected', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Sentry signature required' });
  }

  // Compute expected HMAC-SHA256 signature from the raw body
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const expectedSignature = crypto
    .createHmac('sha256', clientSecret)
    .update(rawBody)
    .digest('hex');

  // Timing-safe comparison
  const expected = Buffer.from(expectedSignature, 'utf8');
  const provided = Buffer.from(String(signature), 'utf8');

  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    logger.warn('Sentry webhook signature invalid — request rejected', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(403).json({ error: 'Invalid Sentry signature' });
  }

  return next();
}

module.exports = { verifySessionSecret, verifySentrySignature };
