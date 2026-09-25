const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.MEDIAOCEAN_SLACK_MEMBER_ID || 'U08S7AVJ478';

const PRODUCTS = {
  prisma: {
    label: 'Prisma',
    tagline: 'End-to-end workflow automation for media buying and finance',
  },
  nivo: {
    label: 'NIVO AI',
    tagline: 'The AI powering advertising at the speed of light',
  },
  innovid: {
    label: 'Innovid',
    tagline: 'Omnichannel ad serving, creative personalization, measurement, and optimization',
  },
  protected: {
    label: 'Protected',
    tagline: 'Verification solutions including brand safety, SIVT, viewability, and attention',
  },
};

const REGIONS = {
  north_america: { label: 'North America' },
  emea: { label: 'EMEA' },
  apac: { label: 'APAC' },
  latam: { label: 'LATAM' },
};

const SPECIALIST_ROUTING = {
  prisma_media: {
    north_america: { team: 'Prisma Solutions — Americas', responseSlaHours: 24 },
    emea: { team: 'Prisma Solutions — EMEA', responseSlaHours: 24 },
    apac: { team: 'Prisma Solutions — APAC', responseSlaHours: 24 },
    latam: { team: 'Prisma Solutions — LATAM', responseSlaHours: 24 },
  },
  nivo: {
    north_america: { team: 'NIVO AI Specialists — Americas', responseSlaHours: 24 },
    emea: { team: 'NIVO AI Specialists — EMEA', responseSlaHours: 24 },
    apac: { team: 'NIVO AI Specialists — APAC', responseSlaHours: 24 },
    latam: { team: 'NIVO AI Specialists — LATAM', responseSlaHours: 24 },
  },
  innovid: {
    north_america: { team: 'Innovid Specialists — Americas', responseSlaHours: 24 },
    emea: { team: 'Innovid Specialists — EMEA', responseSlaHours: 24 },
    apac: { team: 'Innovid Specialists — APAC', responseSlaHours: 24 },
    latam: { team: 'Innovid Specialists — LATAM', responseSlaHours: 24 },
  },
  protected: {
    north_america: { team: 'Protected Verification — Americas', responseSlaHours: 24 },
    emea: { team: 'Protected Verification — EMEA', responseSlaHours: 24 },
    apac: { team: 'Protected Verification — APAC', responseSlaHours: 24 },
    latam: { team: 'Protected Verification — LATAM', responseSlaHours: 24 },
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Mediaocean Schedule a Demo request:',
  '- Service: `app/services/verticals/650815a4.js`',
  '- Route: `app/routes/verticals/650815a4.js`',
  '- Page: `app/public/verticals/650815a4.html` (served at `/mediaocean`)',
  '',
  'Preserve the existing behavior for every registered product and region.',
  'Run `npx jest tests/650815a4-demo-request.test.js --runInBand` and `npm run lint`.',
  'Verify the form at `/mediaocean` submits successfully for the default product.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validateDemoRequest(data) {
  if (!data.workEmail || !data.firstName || !data.lastName || !data.company) {
    const error = new Error('Complete your contact details so our team can follow up.');
    error.name = 'ValidationError';
    error.code = 'CONTACT_DETAILS_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  if (!PRODUCTS[data.product] || !REGIONS[data.region]) {
    const error = new Error('Select a valid product and region.');
    error.name = 'ValidationError';
    error.code = 'DEMO_DETAILS_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function resolveSpecialistRouting(product, region) {
  return SPECIALIST_ROUTING[product][region];
}

function buildDemoBrief(requestId, data, routing) {
  const product = PRODUCTS[data.product];

  return {
    success: true,
    requestId,
    status: 'scheduled',
    product: {
      key: data.product,
      label: product.label,
      tagline: product.tagline,
    },
    region: REGIONS[data.region].label,
    routing: {
      team: routing.team,
      responseSlaHours: routing.responseSlaHours,
    },
    role: data.role || '',
    message: data.message || '',
  };
}

async function submitDemoRequest(data) {
  const startTime = Date.now();
  const requestId = `MO-${uuidv4().slice(0, 8).toUpperCase()}`;

  validateDemoRequest(data);

  logger.info('Submitting Mediaocean Schedule a Demo request', {
    requestId,
    product: data.product,
    region: data.region,
    service: 'customer-650815a4-demo-request',
    route: '/api/650815a4/demo-request',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 120));

    const routing = resolveSpecialistRouting(data.product, data.region);
    const result = buildDemoBrief(requestId, data, routing);
    const duration = Date.now() - startTime;

    incrementMetric('demo_request.submission_success', {
      route: '/api/650815a4/demo-request',
      product: data.product,
      region: data.region,
      team: routing.team,
    });
    recordTiming('demo_request.submission_latency', duration, {
      route: '/api/650815a4/demo-request',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('demo_request.submission_failure', {
      route: '/api/650815a4/demo-request',
      product: data.product,
      region: data.region,
      errorClass: error.name,
    });
    recordTiming('demo_request.submission_latency', duration, {
      route: '/api/650815a4/demo-request',
      error: 'true',
    });

    logger.error('Mediaocean Schedule a Demo request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      product: data.product,
      region: data.region,
      service: 'customer-650815a4-demo-request',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/650815a4/demo-request',
        service: 'customer-650815a4-demo-request',
        product: data.product,
        region: data.region,
      },
      extra: {
        requestId,
        company: data.company,
        role: data.role,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/650815a4.js — buildDemoBrief',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-650815a4-demo-request',
      verticalLabel: 'Mediaocean Schedule a Demo',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '650815a4',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: '/api/650815a4/demo-request' },
        { key: 'service', value: 'customer-650815a4-demo-request' },
        { key: 'product', value: data.product },
        { key: 'region', value: data.region },
      ],
      extra: {
        requestId,
        company: data.company,
        role: data.role,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-650815a4-demo-request@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Mediaocean demo request error', {
        error: alertError.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  submitDemoRequest,
  resolveSpecialistRouting,
  buildDemoBrief,
  PRODUCTS,
  REGIONS,
  SPECIALIST_ROUTING,
  REMEDIATION_DIRECTIVE,
};
