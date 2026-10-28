const crypto = require('crypto');
const logger = require('../telemetry/logger');

const SUPPORTED_ENCODINGS = ['hex', 'base64'];

/**
 * Factory for Express middleware that verifies an HMAC webhook signature.
 *
 * Options:
 *   - secretEnv:       name of the env var holding the shared secret (required)
 *   - signatureHeader: request header carrying the signature (required)
 *   - algorithm:       HMAC algorithm (default 'sha256')
 *   - encoding:        digest encoding, 'hex' or 'base64' (default 'hex')
 *   - signaturePrefix: optional prefix stripped from the header value
 *                      (e.g. 'sha256=' for GitHub-style signatures)
 *
 * When the configured env var is NOT set, the middleware is a no-op
 * (pass-through) to maintain backward compatibility.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyWebhookSignature(options = {}) {
  const {
    secretEnv,
    signatureHeader,
    algorithm = 'sha256',
    encoding = 'hex',
    signaturePrefix = '',
  } = options;

  if (!secretEnv) {
    throw new TypeError('verifyWebhookSignature: secretEnv is required');
  }
  if (!signatureHeader) {
    throw new TypeError('verifyWebhookSignature: signatureHeader is required');
  }
  if (!SUPPORTED_ENCODINGS.includes(encoding)) {
    throw new TypeError(`verifyWebhookSignature: unsupported encoding '${encoding}'`);
  }

  const headerName = signatureHeader.toLowerCase();

  return function webhookSignatureMiddleware(req, res, next) {
    const secret = process.env[secretEnv];

    // If no secret is configured, skip verification (backward-compat)
    if (!secret) {
      return next();
    }

    let signature = req.headers[headerName];
    if (!signature) {
      logger.warn('Webhook signature missing — request rejected', {
        path: req.path,
        ip: req.ip,
      });
      return res.status(401).json({ error: 'Webhook signature required' });
    }

    signature = String(signature);
    if (signaturePrefix && signature.startsWith(signaturePrefix)) {
      signature = signature.slice(signaturePrefix.length);
    }

    // Compute expected HMAC signature from the raw body
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expectedSignature = crypto
      .createHmac(algorithm, secret)
      .update(rawBody)
      .digest(encoding);

    // Timing-safe comparison
    const expected = Buffer.from(expectedSignature, 'utf8');
    const provided = Buffer.from(signature, 'utf8');

    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      logger.warn('Webhook signature invalid — request rejected', {
        path: req.path,
        ip: req.ip,
      });
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }

    return next();
  };
}

module.exports = { verifyWebhookSignature };
