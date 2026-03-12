const express = require('express');
const logger = require('../telemetry/logger');
const { verifySignature, handlePushEvent, handlePullRequestEvent } = require('../services/github-webhook');

const router = express.Router();

/**
 * POST /webhook/github - Receive GitHub webhook events
 */
router.post('/webhook/github', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  const deliveryId = req.headers['x-github-delivery'];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  // Verify signature if secret is configured
  if (secret) {
    if (!signature) {
      logger.warn('GitHub webhook missing signature header', { deliveryId });
      return res.status(401).json({ error: 'Missing signature' });
    }
    const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (!verifySignature(rawBody, signature, secret)) {
      logger.warn('GitHub webhook signature verification failed', { deliveryId });
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  logger.info('GitHub webhook received', {
    event,
    deliveryId,
  });

  let result;
  switch (event) {
    case 'push':
      result = handlePushEvent(payload);
      break;
    case 'pull_request':
      result = handlePullRequestEvent(payload);
      break;
    case 'ping':
      result = { event: 'ping', zen: payload.zen };
      break;
    default:
      result = { event, message: 'Unhandled event type' };
  }

  res.json({ received: true, ...result });
});

module.exports = router;
