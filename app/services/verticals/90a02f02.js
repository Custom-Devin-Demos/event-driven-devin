const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CAPABILITIES = [
  { id: 'genai-strategy', name: 'Enterprise GenAI Strategy', category: 'AI & Data' },
  { id: 'legacy-modernization', name: 'Legacy Modernization', category: 'Engineering' },
  { id: 'salesforce-governance', name: 'Salesforce governance', category: 'Platforms' },
  { id: 'superapps', name: 'Scalable SuperApps', category: 'Digital Products' },
];

const DELIVERY_REGIONS = [
  { id: 'sao-paulo', name: 'São Paulo', hub: 'São Paulo hub' },
  { id: 'curitiba', name: 'Curitiba', hub: 'South hub' },
  { id: 'recife', name: 'Recife', hub: 'Northeast hub' },
];

const SQUAD_ROLES = [
  { role: 'Engineering Lead', monthlyRate: 42000 },
  { role: 'Product Manager', monthlyRate: 32000 },
  { role: 'Senior Software Engineer', monthlyRate: 28000 },
  { role: 'Data / AI Engineer', monthlyRate: 30000 },
  { role: 'UX Designer', monthlyRate: 22000 },
];

const RATE_CARDS = {
  'ENTERPRISE GENAI STRATEGY::SÃO PAULO': { squadRate: 132000, velocity: '8-week discovery' },
  'LEGACY MODERNIZATION::CURITIBA': { squadRate: 118000, velocity: '12-week foundation' },
  'SALESFORCE GOVERNANCE::SÃO PAULO': { squadRate: 96000, velocity: '10-week enablement' },
  'SCALABLE SUPERAPPS::RECIFE': { squadRate: 108000, velocity: '12-week product launch' },
};

function buildRateCardKey(capability, deliveryRegion) {
  return `${capability} | ${deliveryRegion}`.toLowerCase();
}

function resolveRateCard(capability, deliveryRegion) {
  return RATE_CARDS[buildRateCardKey(capability, deliveryRegion)];
}

function buildStaffingPlan(rateCard, capability) {
  const squadRate = rateCard.squadRate;
  const roles = capability === 'Enterprise GenAI Strategy'
    ? ['Engineering Lead', 'Product Manager', 'Data / AI Engineer', 'Senior Software Engineer']
    : ['Engineering Lead', 'Product Manager', 'Senior Software Engineer', 'UX Designer'];
  return {
    monthlyRate: squadRate,
    roles: roles.map((role) => SQUAD_ROLES.find((item) => item.role === role)),
    velocity: rateCard.velocity,
  };
}

async function scopeEngagement(data) {
  const requestId = uuidv4();
  const startedAt = Date.now();
  const route = '/api/90a02f02/inquiry';
  const service = '90a02f02-api';
  logger.info('Scoping Zup solution engagement', {
    requestId,
    capability: data.capability,
    deliveryRegion: data.deliveryRegion,
    service,
    route,
  });

  try {
    const rateCard = resolveRateCard(data.capability, data.deliveryRegion);
    const staffing = buildStaffingPlan(rateCard, data.capability);
    const result = {
      requestId,
      capability: data.capability,
      deliveryRegion: data.deliveryRegion,
      staffing,
      summary: `${staffing.velocity} ${data.capability} engagement delivered from the ${data.deliveryRegion} hub.`,
    };
    incrementMetric('solution_engagement.success', { route, service });
    recordTiming('solution_engagement.latency', Date.now() - startedAt, { route, service });
    return result;
  } catch (error) {
    incrementMetric('solution_engagement.failure', { route, service, errorClass: error.name });
    recordTiming('solution_engagement.latency', Date.now() - startedAt, { route, service, error: 'true' });
    logger.error('Zup solution engagement scoping failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      service,
    });
    Sentry.captureException(error, {
      tags: { route, service, capability: data.capability },
      extra: { requestId, capability: data.capability, deliveryRegion: data.deliveryRegion },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/90a02f02.js — buildStaffingPlan',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail || 'jaime@cognition.ai',
      service,
      verticalLabel: 'Zup Innovation Solutions',
      customer: '90a02f02',
      tags: [
        { key: 'route', value: route },
        { key: 'service', value: service },
        { key: 'capability', value: data.capability },
      ],
      extra: { requestId, capability: data.capability, deliveryRegion: data.deliveryRegion },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: '90a02f02@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Zup solution error', {
        error: alertError.message,
        requestId,
      });
    });
    throw error;
  }
}

module.exports = {
  scopeEngagement,
  CAPABILITIES,
  DELIVERY_REGIONS,
  SQUAD_ROLES,
};
