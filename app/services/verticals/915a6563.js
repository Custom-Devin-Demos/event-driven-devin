const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.MAINSPRING_SLACK_MEMBER_ID || 'U08S7AVJ478';

const MARKETS = {
  data_center: {
    label: 'Prime Power Data Center Power Supply',
    solution: 'Firm onsite power for accelerated time-to-capacity',
  },
  utility: {
    label: 'Utility-scale / Grid-side Applications',
    solution: 'Dispatchable distributed generation for grid capacity',
  },
  enterprise: {
    label: 'Local Generation or Microgrids',
    solution: 'Resilient local generation for enterprise facilities',
  },
  industrial: {
    label: 'Energy Infrastructure (O&G, Chemicals)',
    solution: 'Fuel-flexible power for industrial operations',
  },
};

const CAPACITY_BANDS = {
  up_to_1: { label: '0 – 1 MW', designCapacityMw: 1 },
  one_to_ten: { label: '1 – 10 MW', designCapacityMw: 5 },
  ten_to_fifty: { label: '10 – 50 MW', designCapacityMw: 25 },
  fifty_to_hundred: { label: '50 – 100 MW', designCapacityMw: 75 },
  hundred_to_five_hundred: { label: '100 – 500 MW', designCapacityMw: 250 },
  five_hundred_plus: { label: '500 MW+', designCapacityMw: 500 },
};

const PROJECT_ROUTING = {
  data_center: {
    up_to_1: { team: 'Commercial Projects', responseSlaHours: 24, priority: 'standard' },
    one_to_ten: { team: 'Data Center Solutions', responseSlaHours: 12, priority: 'high' },
    ten_to_fifty: { team: 'Data Center Solutions', responseSlaHours: 8, priority: 'high' },
    fifty_to_hundred: { team: 'Strategic Data Center Programs', responseSlaHours: 4, priority: 'critical' },
    five_hundred_plus: { team: 'Strategic Data Center Programs', responseSlaHours: 2, priority: 'critical' },
  },
  utility: {
    up_to_1: { team: 'Utility Solutions', responseSlaHours: 24, priority: 'standard' },
    one_to_ten: { team: 'Utility Solutions', responseSlaHours: 12, priority: 'high' },
    ten_to_fifty: { team: 'Grid Programs', responseSlaHours: 8, priority: 'high' },
    fifty_to_hundred: { team: 'Grid Programs', responseSlaHours: 4, priority: 'critical' },
    hundred_to_five_hundred: { team: 'Strategic Utility Programs', responseSlaHours: 4, priority: 'critical' },
    five_hundred_plus: { team: 'Strategic Utility Programs', responseSlaHours: 2, priority: 'critical' },
  },
  enterprise: {
    up_to_1: { team: 'Commercial Projects', responseSlaHours: 24, priority: 'standard' },
    one_to_ten: { team: 'Enterprise Solutions', responseSlaHours: 12, priority: 'standard' },
    ten_to_fifty: { team: 'Enterprise Solutions', responseSlaHours: 8, priority: 'high' },
    fifty_to_hundred: { team: 'Strategic Programs', responseSlaHours: 4, priority: 'critical' },
    hundred_to_five_hundred: { team: 'Strategic Programs', responseSlaHours: 4, priority: 'critical' },
    five_hundred_plus: { team: 'Strategic Programs', responseSlaHours: 2, priority: 'critical' },
  },
  industrial: {
    up_to_1: { team: 'Industrial Solutions', responseSlaHours: 24, priority: 'standard' },
    one_to_ten: { team: 'Industrial Solutions', responseSlaHours: 12, priority: 'standard' },
    ten_to_fifty: { team: 'Industrial Programs', responseSlaHours: 8, priority: 'high' },
    fifty_to_hundred: { team: 'Industrial Programs', responseSlaHours: 4, priority: 'critical' },
    hundred_to_five_hundred: { team: 'Strategic Industrial Programs', responseSlaHours: 4, priority: 'critical' },
    five_hundred_plus: { team: 'Strategic Industrial Programs', responseSlaHours: 2, priority: 'critical' },
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Mainspring Energy Get Power inquiry:',
  '- Service: `app/services/verticals/915a6563.js`',
  '- Route: `app/routes/verticals/915a6563.js`',
  '- Page: `app/public/verticals/915a6563.html` (served at `/mainspring`)',
  '',
  'Preserve the existing behavior for every registered market and capacity band.',
  'Run `npx jest tests/915a6563-power-inquiry.test.js --runInBand` and `npm run lint`.',
  'Verify the form at `/mainspring` submits successfully for the affected capacity band.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validateInquiry(data) {
  if (!data.workEmail || !data.firstName || !data.lastName || !data.company) {
    const error = new Error('Complete your contact details so our power team can follow up.');
    error.name = 'ValidationError';
    error.code = 'CONTACT_DETAILS_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  if (!MARKETS[data.market] || !CAPACITY_BANDS[data.capacityNeed]) {
    const error = new Error('Select a valid project type and capacity need.');
    error.name = 'ValidationError';
    error.code = 'PROJECT_DETAILS_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function resolveProjectRouting(market, capacityNeed) {
  return PROJECT_ROUTING[market][capacityNeed];
}

function buildProjectBrief(inquiryId, data, routing) {
  const market = MARKETS[data.market];
  const capacity = CAPACITY_BANDS[data.capacityNeed];
  const generatorPackages = Math.ceil(capacity.designCapacityMw / 2.5);

  return {
    success: true,
    inquiryId,
    status: 'received',
    project: {
      market: market.label,
      solution: market.solution,
      capacity: capacity.label,
      designCapacityMw: capacity.designCapacityMw,
      generatorPackages,
      country: data.projectCountry || 'United States',
      state: data.projectState || '',
      timeline: data.timeline || 'Evaluating options',
    },
    routing: {
      team: routing.team,
      responseSlaHours: routing.responseSlaHours,
      priority: routing.priority,
    },
  };
}

async function submitPowerInquiry(data) {
  const startTime = Date.now();
  const inquiryId = `MSE-${uuidv4().slice(0, 8).toUpperCase()}`;

  validateInquiry(data);

  logger.info('Submitting Mainspring Get Power inquiry', {
    inquiryId,
    market: data.market,
    capacityNeed: data.capacityNeed,
    service: 'customer-915a6563-power-inquiry',
    route: '/api/915a6563/power-inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 120));

    const routing = resolveProjectRouting(data.market, data.capacityNeed);
    const result = buildProjectBrief(inquiryId, data, routing);
    const duration = Date.now() - startTime;

    incrementMetric('power_inquiry.submission_success', {
      route: '/api/915a6563/power-inquiry',
      market: data.market,
      capacity: data.capacityNeed,
      team: routing.team,
    });
    recordTiming('power_inquiry.submission_latency', duration, {
      route: '/api/915a6563/power-inquiry',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('power_inquiry.submission_failure', {
      route: '/api/915a6563/power-inquiry',
      market: data.market,
      capacity: data.capacityNeed,
      errorClass: error.name,
    });
    recordTiming('power_inquiry.submission_latency', duration, {
      route: '/api/915a6563/power-inquiry',
      error: 'true',
    });

    logger.error('Mainspring Get Power inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      market: data.market,
      capacityNeed: data.capacityNeed,
      service: 'customer-915a6563-power-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/915a6563/power-inquiry',
        service: 'customer-915a6563-power-inquiry',
        market: data.market,
        capacity: data.capacityNeed,
      },
      extra: {
        inquiryId,
        company: data.company,
        projectCountry: data.projectCountry,
        projectState: data.projectState,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/915a6563.js — buildProjectBrief',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-915a6563-power-inquiry',
      verticalLabel: 'Mainspring Get Power',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '915a6563',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: '/api/915a6563/power-inquiry' },
        { key: 'service', value: 'customer-915a6563-power-inquiry' },
        { key: 'market', value: data.market },
        { key: 'capacity', value: data.capacityNeed },
      ],
      extra: {
        inquiryId,
        company: data.company,
        projectCountry: data.projectCountry,
        projectState: data.projectState,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-915a6563-power-inquiry@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Mainspring inquiry error', {
        error: alertError.message,
        inquiryId,
      });
    });

    throw error;
  }
}

module.exports = {
  submitPowerInquiry,
  resolveProjectRouting,
  buildProjectBrief,
  MARKETS,
  CAPACITY_BANDS,
  PROJECT_ROUTING,
  REMEDIATION_DIRECTIVE,
};
