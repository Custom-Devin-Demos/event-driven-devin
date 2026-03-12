const crypto = require('crypto');
const logger = require('../telemetry/logger');

/**
 * Verify GitHub webhook signature
 */
function verifySignature(payload, signature, secret) {
  if (!secret || !signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  const sigBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);
  if (sigBuffer.length !== digestBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, digestBuffer);
}

/**
 * Handle push events - update version, log deploy
 */
function handlePushEvent(payload) {
  const ref = payload.ref || '';
  const commits = payload.commits || [];
  const pusher = payload.pusher ? payload.pusher.name : 'unknown';
  const headCommit = payload.head_commit || {};

  logger.info('GitHub push event received', {
    ref,
    commitCount: commits.length,
    pusher,
    headCommitId: headCommit.id ? headCommit.id.substring(0, 8) : 'unknown',
    headCommitMessage: headCommit.message || '',
  });

  // Check if this is a version tag
  const tagMatch = ref.match(/^refs\/tags\/v?(\d+\.\d+\.\d+)$/);
  if (tagMatch) {
    const version = tagMatch[1];
    logger.info('Version tag detected', { version, ref });
    process.env.APP_VERSION = version;
    process.env.DD_VERSION = version;
    process.env.SENTRY_RELEASE = `acme-checkout@${version}`;
  }

  return {
    event: 'push',
    ref,
    commits: commits.length,
    pusher,
    headCommit: headCommit.id ? headCommit.id.substring(0, 8) : null,
    message: headCommit.message || null,
  };
}

/**
 * Handle pull_request events
 */
function handlePullRequestEvent(payload) {
  const action = payload.action || 'unknown';
  const pr = payload.pull_request || {};
  const number = pr.number || 0;
  const title = pr.title || '';
  const user = pr.user ? pr.user.login : 'unknown';
  const merged = pr.merged || false;

  logger.info('GitHub pull_request event received', {
    action,
    prNumber: number,
    title,
    user,
    merged,
  });

  return {
    event: 'pull_request',
    action,
    number,
    title,
    user,
    merged,
  };
}

module.exports = { verifySignature, handlePushEvent, handlePullRequestEvent };
