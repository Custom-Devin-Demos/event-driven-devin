const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const PLAN_TIERS = [
  { id: 'basic', label: 'Basic', seats: 1, monthlyPrice: 0, features: ['Meetings', 'Chat', 'Notes'] },
  { id: 'pro', label: 'Pro', seats: 10, monthlyPrice: 13.33, features: ['Meetings', 'Chat', 'Notes', 'Cloud Storage', 'Clips'] },
  { id: 'business', label: 'Business', seats: 100, monthlyPrice: 18.33, features: ['Meetings', 'Chat', 'Notes', 'Cloud Storage', 'Clips', 'Phone', 'Whiteboard'] },
  { id: 'enterprise', label: 'Enterprise', seats: 500, monthlyPrice: 22.49, features: ['All Business', 'Rooms', 'Webinars', 'Contact Center'] },
];

const ADDON_CATALOG = {
  'ai-companion': { name: 'AI Companion', monthlyBase: 0, category: 'ai', unit: 'included' },
  'zoom-phone': { name: 'Zoom Phone', monthlyBase: 10, category: 'comms', unit: 'user' },
  'zoom-rooms': { name: 'Zoom Rooms', monthlyBase: 49, category: 'workspace', unit: 'room' },
  'zoom-webinars': { name: 'Zoom Webinars', monthlyBase: 79, category: 'events', unit: 'host' },
  'zoom-contact-center': { name: 'Contact Center', monthlyBase: 69, category: 'support', unit: 'agent' },
  'workvivo': { name: 'Workvivo', monthlyBase: 5, category: 'engagement', unit: 'user' },
};

const REGION_CONFIG = {
  na: { factor: 1.0, currency: 'USD', taxRate: 0.0875, label: 'North America' },
  emea: { factor: 1.12, currency: 'EUR', taxRate: 0.20, label: 'EMEA' },
  apac: { factor: 0.95, currency: 'USD', taxRate: 0.10, label: 'Asia Pacific' },
  latam: { factor: 0.88, currency: 'USD', taxRate: 0.16, label: 'Latin America' },
};

function resolvePlan(planId) {
  return PLAN_TIERS.find((p) => p.id === planId);
}

function buildAddonBundle(addonKeys) {
  const items = [];
  for (const key of addonKeys) {
    const addon = ADDON_CATALOG[key];
    if (addon) {
      items.push({
        key,
        name: addon.name,
        monthlyBase: addon.monthlyBase,
        category: addon.category,
        unit: addon.unit,
      });
    }
  }
  return items;
}

function computeLicenseCost(plan, bundle, region, seatCount) {
  const regionCfg = REGION_CONFIG[region];
  const baseCost = plan.monthlyPrice * seatCount * regionCfg.factor;

  const addonCosts = bundle.map((item) => {
    const cost = item.monthlyBase * regionCfg.factor;
    return {
      addon: item.name,
      monthlyCost: Math.round(cost * 100) / 100,
      unit: item.unit,
    };
  });

  const totalAddonMonthly = addonCosts.reduce((sum, a) => sum + a.monthlyCost, 0);
  const monthlyTotal = baseCost + totalAddonMonthly;
  const annualSubtotal = monthlyTotal * 12;
  const taxAmount = annualSubtotal * regionCfg.taxRate;

  return {
    plan: plan.label,
    seatCount,
    pricePerSeat: Math.round(plan.monthlyPrice * regionCfg.factor * 100) / 100,
    seatSubtotal: Math.round(baseCost * 100) / 100,
    addons: addonCosts,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
    annualSubtotal: Math.round(annualSubtotal * 100) / 100,
    tax: Math.round(taxAmount * 100) / 100,
    annualTotal: Math.round((annualSubtotal + taxAmount) * 100) / 100,
    currency: regionCfg.currency,
  };
}

function buildDeploymentPlan(licensing, plan, bundle) {
  const deployment = {
    workspaces: [],
    resourceAllocation: {},
    aiCapacity: 0,
  };

  for (const item of bundle) {
    deployment.workspaces.push({
      addon: item.name,
      edition: plan.label,
      status: 'pending_activation',
    });
  }

  const storagePerSeat = plan.id === 'enterprise' ? 20 : plan.id === 'business' ? 10 : 5;
  deployment.resourceAllocation.storageGb = licensing.seatCount * storagePerSeat;
  deployment.resourceAllocation.apiCallsDaily = licensing.seatCount * 500;

  const aiAddon = bundle.find((b) => b.unit === 'included');
  if (aiAddon) {
    deployment.aiCapacity = licensing.seatCount * 200;
  }

  const certLevel = plan.id === 'enterprise' ? 'soc2-type2' : plan.id === 'business' ? 'soc2-type1' : 'basic';
  deployment.governance = {
    certificationLevel: certLevel,
    dataResidency: 'regional',
    auditLogging: plan.id === 'enterprise' || plan.id === 'business',
  };

  return deployment;
}

function assembleInquiryResponse(licensing, deploymentPlan, region) {
  const regionCfg = REGION_CONFIG[region];
  const response = {
    region: regionCfg.label,
    currency: regionCfg.currency,
    licensing,
    deployment: deploymentPlan,
    estimatedActivationDays: deploymentPlan.workspaces.length * 2 + 5,
    supportLevel: licensing.plan === 'Enterprise' ? 'Premier' : 'Standard',
  };

  response.readinessScore = evaluateReadiness(deploymentPlan);
  response.complianceStatus = deploymentPlan.governance.certificationLevel;
  return response;
}

function evaluateReadiness(deploymentPlan) {
  let score = 100;
  const workspaceCount = deploymentPlan.workspaces.length;
  if (workspaceCount > 4) score -= 12;
  if (deploymentPlan.resourceAllocation.storageGb > 3000) score -= 8;
  if (deploymentPlan.aiCapacity > 0) score += 5;
  return Math.max(0, Math.min(100, score));
}

async function processInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing platform inquiry', {
    inquiryId,
    plan: data.plan,
    region: data.region,
    addons: data.addons,
    service: 'customer-d5fc3172-workspace',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const plan = resolvePlan(data.plan || 'business');
    const bundle = buildAddonBundle(data.addons || ['ai-companion', 'zoom-phone', 'zoom-rooms']);
    const seatCount = data.seats || 200;
    const region = data.region || 'na';

    const licensing = computeLicenseCost(plan, bundle, region, seatCount);
    const deploymentPlan = buildDeploymentPlan(licensing, plan, bundle);
    const response = assembleInquiryResponse(licensing, deploymentPlan, region);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/d5fc3172/inquiry',
      plan: data.plan,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/d5fc3172/inquiry',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/d5fc3172/inquiry',
      errorClass: error.name,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/d5fc3172/inquiry',
      error: 'true',
    });

    logger.error('Platform inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      plan: data.plan,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/d5fc3172/inquiry',
        service: 'customer-d5fc3172-workspace',
        plan: data.plan,
      },
      extra: { inquiryId, plan: data.plan, region: data.region },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/d5fc3172.js \u2014 processInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-d5fc3172-workspace',
      verticalLabel: 'Workspace Inquiry',
      customer: 'd5fc3172',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/d5fc3172/inquiry' },
        { key: 'service', value: 'customer-d5fc3172-workspace' },
        { key: 'plan', value: data.plan },
      ],
      extra: { inquiryId, plan: data.plan, region: data.region },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-d5fc3172-workspace@1.2.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for inquiry error', {
        error: err.message,
        inquiryId,
      });
    });

    throw error;
  }
}

module.exports = { processInquiry, PLAN_TIERS, ADDON_CATALOG };
