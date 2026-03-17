const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Session quota limits by plan tier
 */
const PLAN_QUOTAS = {
  free: { maxConcurrent: 1, maxDaily: 5, maxPromptLength: 2000 },
  team: { maxConcurrent: 5, maxDaily: 50, maxPromptLength: 10000 },
  enterprise: { maxConcurrent: 20, maxDaily: 500, maxPromptLength: 50000 },
};

/**
 * Available playbooks for session creation
 */
const PLAYBOOKS = [
  { id: 'default', name: 'Default', description: 'General-purpose coding assistant' },
  { id: 'bug-fix', name: 'Bug Fix', description: 'Investigate and fix reported bugs' },
  { id: 'feature', name: 'New Feature', description: 'Build new features from requirements' },
  { id: 'refactor', name: 'Refactor', description: 'Improve code quality and structure' },
];

/**
 * Mock sessions for the demo
 */
const SESSIONS = [
  { id: 'session_a1b2c3', prompt: 'Fix auth token refresh logic', repo: 'acme/payments-api', status: 'running', createdAt: '2026-03-17T19:45:00Z', duration: 720 },
  { id: 'session_d4e5f6', prompt: 'Add dark mode to settings page', repo: 'acme/web-frontend', status: 'complete', createdAt: '2026-03-17T18:30:00Z', duration: 2400 },
  { id: 'session_g7h8i9', prompt: 'Migrate DB schema to v3', repo: 'acme/data-pipeline', status: 'complete', createdAt: '2026-03-17T16:15:00Z', duration: 4800 },
  { id: 'session_j0k1l2', prompt: 'Set up CI/CD pipeline', repo: 'acme/auth-service', status: 'queued', createdAt: '2026-03-17T14:00:00Z', duration: 0 },
];

/**
 * Simulates an async quota check against the billing service.
 * Returns the remaining session capacity for the org.
 */
async function validateSessionQuota(orgPlan) {
  await new Promise((resolve) => setTimeout(resolve, 30));
  const quota = PLAN_QUOTAS[orgPlan];
  if (!quota) {
    throw Object.assign(new Error(`Unknown plan: ${orgPlan}`), { code: 'INVALID_PLAN' });
  }
  const activeSessions = SESSIONS.filter((s) => s.status === 'running').length;
  return {
    remaining: quota.maxConcurrent - activeSessions,
    maxConcurrent: quota.maxConcurrent,
    activeSessions,
  };
}

/**
 * Resolve the playbook configuration for a session.
 */
function resolvePlaybook(playbookId) {
  return PLAYBOOKS.find((p) => p.id === playbookId);
}

/**
 * Build the session metadata from the request and quota info.
 *
 * BUG: This function receives `quotaInfo` which is expected to be a
 * resolved object with a `.remaining` property. However, the caller
 * forgot to `await` the async `validateSessionQuota()` call, so
 * `quotaInfo` is actually a Promise. Accessing `.remaining` on a
 * Promise yields `undefined`, and `undefined - 1` produces `NaN`.
 * The downstream `.toFixed()` call on `NaN` succeeds (returns "NaN"),
 * but the capacity guard `remaining < 1` is false for NaN (since
 * NaN < 1 is false), allowing the session to proceed. The real crash
 * comes when `formatSessionResponse()` tries to call `.padStart()`
 * on the numeric `remaining` value — but since it's `NaN` (a number),
 * `.padStart()` doesn't exist, throwing:
 *   TypeError: quotaSnapshot.capacityRemaining.padStart is not a function
 */
function buildSessionMeta(data, quotaInfo, playbook) {
  const remaining = quotaInfo.remaining - 1;
  return {
    sessionId: uuidv4(),
    prompt: data.prompt,
    repository: data.repository,
    priority: data.priority,
    playbook: playbook.name,
    playbookDesc: playbook.description,
    capacityRemaining: remaining,
    orgPlan: data.orgPlan || 'team',
    notifyVia: data.notifyVia || 'slack',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Format the final session response, including a human-readable
 * capacity string.
 */
function formatSessionResponse(meta) {
  const capacityStr = String(meta.capacityRemaining).padStart(2, '0');
  return {
    success: true,
    sessionId: meta.sessionId,
    prompt: meta.prompt,
    repository: meta.repository,
    priority: meta.priority,
    playbook: meta.playbook,
    status: 'provisioning',
    capacityRemaining: `${capacityStr}/${meta.orgPlan}`,
    notifyVia: meta.notifyVia,
    createdAt: meta.createdAt,
  };
}

/**
 * Create a new Devin session.
 */
async function createDevinSession(data) {
  const startTime = Date.now();
  const sessionId = uuidv4();

  logger.info('Creating Devin session', {
    sessionId,
    prompt: data.prompt,
    repository: data.repository,
    priority: data.priority,
    service: 'devin-platform',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const playbook = resolvePlaybook(data.playbook || 'default');
    if (!playbook) {
      throw Object.assign(
        new Error(`Playbook not found: ${data.playbook}`),
        { code: 'PLAYBOOK_NOT_FOUND' },
      );
    }

    // BUG: Missing `await` — validateSessionQuota is async but the
    // result is used as if it were the resolved value.
    const quotaCheck = validateSessionQuota(data.orgPlan || 'team');

    const meta = buildSessionMeta(data, quotaCheck, playbook);
    const response = formatSessionResponse(meta);

    const duration = Date.now() - startTime;

    incrementMetric('session.create.success', {
      route: '/api/devin/sessions',
      priority: data.priority,
    });
    recordTiming('session.create.latency', duration, {
      route: '/api/devin/sessions',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('session.create.failure', {
      route: '/api/devin/sessions',
      errorClass: error.name,
      priority: data.priority,
    });
    recordTiming('session.create.latency', duration, {
      route: '/api/devin/sessions',
      error: 'true',
    });

    logger.error('Session creation failed', {
      sessionId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      repository: data.repository,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/devin/sessions',
        service: 'devin-platform',
        priority: data.priority,
      },
      extra: { sessionId, prompt: data.prompt, repository: data.repository },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/devin.js — createDevinSession',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'devin-platform',
      verticalLabel: 'Devin Session Create',
      tags: [
        { key: 'route', value: '/api/devin/sessions' },
        { key: 'service', value: 'devin-platform' },
        { key: 'priority', value: data.priority },
      ],
      extra: { sessionId, prompt: data.prompt, repository: data.repository },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'devin-platform@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from session-create error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { createDevinSession, SESSIONS, PLAYBOOKS, PLAN_QUOTAS };
