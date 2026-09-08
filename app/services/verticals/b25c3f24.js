const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { declareDatadogIncident } = require('../datadog-incidents');
const {
  createLinearIssue,
  addLinearComment,
  updateLinearIssueState,
} = require('../linear');

const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID_B25C3F24 || '3c9f0e1e-54da-442d-8949-a62489060822';
const LINEAR_ASSIGNEE_ID = process.env.LINEAR_ASSIGNEE_ID_B25C3F24 || '4d616028-0c12-4ad9-b117-0661170e857e';
const LINEAR_STATE_IN_PROGRESS_ID = process.env.LINEAR_STATE_IN_PROGRESS_B25C3F24 || '99c9b96f-39b3-4a09-9112-53c054f3dbab';
const LINEAR_STATE_IN_REVIEW_ID = process.env.LINEAR_STATE_IN_REVIEW_B25C3F24 || 'd79ea314-a400-4382-9140-d4861fb4e30f';

const PAYMENT_PLANS = [
  {
    id: 'plan-6',
    termMonths: 6,
    apr: 0,
    monthlyPayment: 324.06,
    interest: 0,
    totalOfPayments: 1944.39,
  },
  {
    id: 'plan-12',
    termMonths: 12,
    apr: 31.35,
    monthlyPayment: 190.85,
    interest: 345.87,
    totalOfPayments: 2290.26,
  },
  {
    id: 'plan-24',
    termMonths: 24,
    apr: 31.35,
    monthlyPayment: 110.13,
    interest: 698.86,
    totalOfPayments: 2643.25,
  },
];

/**
 * Verification policy tiers cover the Affirm plan term ranges.
 */
const IDENTITY_VERIFICATION_PROVIDERS = {
  'short-term': {
    provider: 'experian-precise-id',
    kbaRequired: false,
    softPullBureau: 'experian',
    slaSeconds: 3,
  },
  extended: {
    provider: 'experian-precise-id',
    kbaRequired: true,
    softPullBureau: 'experian',
    slaSeconds: 3,
  },
};

function resolveVerificationTier(termMonths) {
  if (termMonths <= 6) return 'short-term';
  if (termMonths <= 18) return 'standard';
  return 'extended';
}

function buildIdentityCheck(plan, ssnLast4) {
  const tier = resolveVerificationTier(plan.termMonths);
  const policy = IDENTITY_VERIFICATION_PROVIDERS[tier];

  return {
    tier,
    provider: policy.provider,
    softPullBureau: policy.softPullBureau,
    kbaRequired: policy.kbaRequired,
    verified: Boolean(ssnLast4),
  };
}

const REMEDIATION_DIRECTIVE = [
  '!checkout_verification_triage',
  '',
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Affirm pay-over-time checkout hosted inside the Brilliant Earth order review page:',
  '- Service: `app/services/verticals/b25c3f24.js`',
  '- Route: `app/routes/verticals/b25c3f24.js`',
  '- Page: `app/public/verticals/b25c3f24.html` (served at `/affirm`)',
  '',
  'Before changing code, pull the runtime evidence through your MCP integrations:',
  '- Sentry MCP: find the latest `TypeError` issue for service `customer-b25c3f24-pay-over-time` and read its stack trace and tags (`plan`, `route`).',
  '- Datadog MCP: query the `affirm_checkout.identity_verification_failure` metric by `plan` tag and the open SEV-2 incident titled "Affirm identity verification failing at checkout"; confirm which plan term is failing and that other terms succeed.',
  'Fix the root cause (the verification-tier policy map, not the crash site), add regression coverage in `tests/affirm-identity-verification.test.js`, and resolve the Datadog incident in the PR description.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function buildRemediationDirective(issue) {
  if (!issue) return REMEDIATION_DIRECTIVE;

  return [
    REMEDIATION_DIRECTIVE,
    '',
    `*Linear ticket:* ${issue.identifier} — ${issue.url}`,
    'The ticket is already In Progress with a comment linking this session. Ticket lifecycle you own:',
    `- As soon as your PR is open: comment on the ticket with the PR URL (Linear MCP \`create_comment\` / or the GraphQL API with \`LINEAR_API_KEY\`), add the PR link to the ticket, and move the ticket to the "In Review" state (id '${LINEAR_STATE_IN_REVIEW_ID}').`,
    '- Do NOT move the ticket to Done. The reviewer moves it to Done after approving and merging the PR.',
    '- If you push follow-up commits after review feedback, leave the ticket In Review and add a short comment.',
  ].join('\n');
}

async function verifyIdentity(data) {
  const startTime = Date.now();
  const checkoutId = uuidv4();
  const merchant = data.merchant || 'brilliant-earth';
  const plan = PAYMENT_PLANS.find((candidate) => candidate.id === data.planId);

  if (!/^\d{4}$/.test(String(data.ssnLast4 || ''))) {
    const validationError = new Error('SSN last four must be exactly four digits.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_SSN_LAST4';
    validationError.statusCode = 400;
    throw validationError;
  }

  if (!plan) {
    const validationError = new Error(`Unknown payment plan: ${data.planId || '(none)'}`);
    validationError.name = 'ValidationError';
    validationError.code = 'UNKNOWN_PLAN';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Verifying Affirm identity', {
    checkoutId,
    plan: data.planId,
    merchant,
    ssnProvided: Boolean(data.ssnLast4),
    service: 'customer-b25c3f24-pay-over-time',
    route: '/api/b25c3f24/verify-identity',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const identityCheck = buildIdentityCheck(plan, data.ssnLast4);
    const result = {
      checkoutId,
      status: 'approved',
      plan: { ...plan },
      identityCheck,
      firstPaymentDue: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      loanId: `AFM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      nextStep: 'confirm-loan',
    };

    const duration = Date.now() - startTime;
    incrementMetric('affirm_checkout.identity_verification_success', {
      plan: data.planId,
      merchant,
    });
    recordTiming('affirm_checkout.identity_verification_latency', duration, {
      plan: data.planId,
      merchant,
      error: 'false',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('affirm_checkout.identity_verification_failure', {
      plan: data.planId,
      merchant,
      errorClass: error.name,
    });
    recordTiming('affirm_checkout.identity_verification_latency', duration, {
      plan: data.planId,
      merchant,
      error: 'true',
    });

    logger.error('Affirm identity verification failed', {
      checkoutId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      plan: data.planId,
      merchant,
      ssnProvided: Boolean(data.ssnLast4),
      service: 'customer-b25c3f24-pay-over-time',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b25c3f24/verify-identity',
        service: 'customer-b25c3f24-pay-over-time',
        plan: data.planId,
        merchant,
      },
      extra: {
        checkoutId,
        ssnProvided: Boolean(data.ssnLast4),
        merchant,
      },
    });

    declareDatadogIncident({
      title: 'Affirm identity verification failing at checkout',
      summary: `${error.name}: ${error.message}. Shoppers selecting the ${plan.termMonths}-month plan cannot complete SSN verification.`,
      runRef: checkoutId,
      service: 'customer-b25c3f24-pay-over-time',
      triggeredBy: data.devinEmail || 'checkout',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((err) => logger.warn('Failed to declare Datadog incident for Affirm identity verification', { error: err.message, checkoutId }));

    (async () => {
      let issue = null;
      try {
        issue = await createLinearIssue({
          title: `[Affirm checkout] ${error.name}: ${error.message}`,
          description: [
            `Shoppers selecting the ${plan ? plan.termMonths : 'selected'}-month plan cannot complete SSN identity verification at Affirm checkout (merchant: ${merchant}).`,
            '',
            '- Service: `customer-b25c3f24-pay-over-time`',
            '- Route: `POST /api/b25c3f24/verify-identity`',
            `- Checkout ref: \`${checkoutId}\``,
            `- Error: \`${error.name}: ${error.message}\``,
            '',
            'Repository: https://github.com/COG-GTM/event-driven-devin (`app/services/verticals/b25c3f24.js`).',
            'Sentry has the stack trace for this service; Datadog has a SEV-2 incident "Affirm identity verification failing at checkout".',
            '',
            'Triage with the `!checkout_verification_triage` playbook.',
          ].join('\n'),
          teamId: LINEAR_TEAM_ID,
          assigneeId: LINEAR_ASSIGNEE_ID,
          priority: 2,
        });
      } catch (err) {
        logger.warn('Failed to create Linear issue for Affirm identity verification', { error: err.message, checkoutId });
      }

      const outcome = await createSessionAndAlert({
        issueTitle: `${error.name}: ${error.message}`,
        issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
        culprit: 'app/services/verticals/b25c3f24.js \u2014 buildIdentityCheck',
        errorType: error.name || 'Error',
        errorValue: error.message,
        devinUserId: data.devinUserId,
        devinEmail: data.devinEmail,
        devinOrgId: data.devinOrgId,
        service: 'customer-b25c3f24-pay-over-time',
        verticalLabel: 'Affirm Pay Over Time Checkout',
        promptAppendix: buildRemediationDirective(issue),
        customer: 'b25c3f24',
        tags: [
          { key: 'route', value: '/api/b25c3f24/verify-identity' },
          { key: 'service', value: 'customer-b25c3f24-pay-over-time' },
          { key: 'plan', value: data.planId },
          { key: 'merchant', value: merchant },
        ],
        extra: {
          checkoutId,
          ssnProvided: Boolean(data.ssnLast4),
          merchant,
        },
        level: 'error',
        platform: 'node',
        firstSeen: '',
        lastSeen: new Date().toISOString(),
        count: '',
        shortId: '',
        project: 'event-driven-devin',
        release: process.env.SENTRY_RELEASE || 'customer-b25c3f24-pay-over-time@1.0.0',
        environment: process.env.DD_ENV || 'prod',
        triggeredRule: '',
      });
      const session = outcome && outcome.session;
      if (issue && session) {
        await addLinearComment({
          issueId: issue.id,
          body: [
            `Devin picked this up: ${session.url}`,
            '',
            'Moving to **In Progress**. The PR link will be posted here and the ticket moved to **In Review** once the fix is ready.',
          ].join('\n'),
        });
        await updateLinearIssueState({ issueId: issue.id, stateId: LINEAR_STATE_IN_PROGRESS_ID });
        logger.info('Linear issue linked to Devin session', {
          identifier: issue.identifier,
          sessionId: session.sessionId,
          checkoutId,
        });
      }
    })().catch((err) => logger.warn('Affirm incident follow-up failed', { error: err.message, checkoutId }));

    throw error;
  }
}

module.exports = {
  verifyIdentity,
  PAYMENT_PLANS,
  IDENTITY_VERIFICATION_PROVIDERS,
  REMEDIATION_DIRECTIVE,
  buildRemediationDirective,
  LINEAR_STATE_IN_PROGRESS_ID,
  LINEAR_STATE_IN_REVIEW_ID,
};
