const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Solutions offered on the "Request a Demo" form. Each solution routes the
 * request to the platform team that owns the demo environment.
 */
const DEMO_SOLUTIONS = [
  { code: 'cloud4retail', label: 'GK CLOUD4RETAIL', platform: 'CLOUD4RETAIL' },
  { code: 'omnipos', label: 'GK OmniPOS', platform: 'OMNIPOS' },
  { code: 'engage', label: 'GK Engage \u2014 Loyalty & Personalization', platform: 'ENGAGE' },
  { code: 'air-price', label: 'GK AIR Price Optimizer', platform: 'AIR-PRICE' },
  { code: 'air-personalization', label: 'GK AIR Personalization', platform: 'AIR-PERSONALIZATION' },
];

/**
 * Platform directory used to attach an owning team, a demo environment
 * track, and a response SLA to every routed demo request.
 *
 * NOTE: CLOUD4RETAIL was renamed from OMNISCALE-CLOUD during the platform
 * rebrand; the directory entry was migrated under the old key.
 */
const PLATFORM_DIRECTORY = {
  'OMNISCALE-CLOUD': {
    name: 'GK CLOUD4RETAIL',
    demoTrack: 'cloud4retail-sandbox',
    slaHours: 24,
    solutionsEngineer: 'store-operations-team',
  },
  OMNIPOS: {
    name: 'GK OmniPOS',
    demoTrack: 'omnipos-sandbox',
    slaHours: 24,
    solutionsEngineer: 'pos-platform-team',
  },
  ENGAGE: {
    name: 'GK Engage',
    demoTrack: 'engage-sandbox',
    slaHours: 48,
    solutionsEngineer: 'loyalty-team',
  },
  'AIR-PRICE': {
    name: 'GK AIR Price Optimizer',
    demoTrack: 'air-price-sandbox',
    slaHours: 48,
    solutionsEngineer: 'ai-retail-team',
  },
  'AIR-PERSONALIZATION': {
    name: 'GK AIR Personalization',
    demoTrack: 'air-personalization-sandbox',
    slaHours: 48,
    solutionsEngineer: 'ai-retail-team',
  },
};

/**
 * Company stats surfaced on the corporate site.
 */
const COMPANY_STATS = [
  { code: 'installations', label: 'POS Installations', value: '500K+' },
  { code: 'countries', label: 'Countries', value: '60+' },
  { code: 'retailers', label: 'of the Top 50 Global Retailers', value: '22%' },
  { code: 'employees', label: 'Employees Worldwide', value: '1,250+' },
];

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the GK Software demo-request vertical:',
  '- Service: `app/services/verticals/784ffbc5.js`',
  '- Route: `app/routes/verticals/784ffbc5.js`',
  '- Page: `app/public/verticals/784ffbc5.html` (served at `/gksoftware`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findSolution(solutionCode) {
  return DEMO_SOLUTIONS.find((solution) => solution.code === solutionCode) || DEMO_SOLUTIONS[0];
}

/**
 * Resolve the platform directory entry that owns a solution.
 */
function resolvePlatform(solution) {
  return PLATFORM_DIRECTORY[solution.platform];
}

/**
 * Build the scheduling envelope attached to an accepted demo request: the
 * owning platform team, the sandbox track the demo runs on, and the response
 * commitment shown to the requester.
 */
function buildSchedulingEnvelope(solution, platform) {
  return {
    solution: solution.label,
    platform: platform.name,
    demoTrack: platform.demoTrack,
    responseCommitmentHours: platform.slaHours,
    solutionsEngineer: platform.solutionsEngineer,
  };
}

/**
 * Assemble the confirmation returned to the requester.
 */
function buildConfirmation(requestId, scheduling) {
  return {
    requestId,
    status: 'received',
    scheduling,
    nextStep: 'A solutions engineer from the ' + scheduling.platform + ' team will reach out within '
      + scheduling.responseCommitmentHours + ' hours to schedule your demo.',
  };
}

/**
 * Submit a demo request from the "Request a Demo" form.
 */
async function submitDemoRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Submitting demo request', {
    requestId,
    solution: data.solution,
    company: data.company,
    service: 'customer-784ffbc5-demo-request',
    route: '/api/784ffbc5/demo-request',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const solution = findSolution(data.solution);
    const platform = resolvePlatform(solution);
    const scheduling = buildSchedulingEnvelope(solution, platform);
    const confirmation = buildConfirmation(requestId, scheduling);

    incrementMetric('demo_request.received', {
      route: '/api/784ffbc5/demo-request',
      solution: solution.code,
    });
    recordTiming('demo_request.latency', Date.now() - startTime, {
      route: '/api/784ffbc5/demo-request',
      error: 'false',
    });

    logger.info('Demo request routed', {
      requestId,
      platform: scheduling.platform,
      demoTrack: scheduling.demoTrack,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('demo_request.failure', {
      route: '/api/784ffbc5/demo-request',
      errorClass: error.name,
      solution: data.solution || 'unknown',
    });
    recordTiming('demo_request.latency', duration, {
      route: '/api/784ffbc5/demo-request',
      error: 'true',
    });

    logger.error('Demo request failed', {
      requestId,
      solution: data.solution,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-784ffbc5-demo-request',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-784ffbc5-demo-request',
        route: '/api/784ffbc5/demo-request',
        solution: data.solution || 'unknown',
      },
      extra: {
        requestId,
        solution: data.solution,
        company: data.company,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/784ffbc5.js \u2014 buildSchedulingEnvelope',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-784ffbc5-demo-request',
      verticalLabel: 'Demo Request Routing',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'default',
      tags: [
        { key: 'route', value: '/api/784ffbc5/demo-request' },
        { key: 'service', value: 'customer-784ffbc5-demo-request' },
        { key: 'solution', value: data.solution || 'unknown' },
      ],
      extra: {
        requestId,
        solution: data.solution,
        company: data.company,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for demo request error', {
        requestId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitDemoRequest,
  DEMO_SOLUTIONS,
  COMPANY_STATS,
};
