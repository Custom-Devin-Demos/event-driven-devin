const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const WORKSPACE_PLANS = {
  starter: { maxUsers: 5, storageGB: 10, certificationLevel: 'none', features: ['basic_docs', 'chat'], supportTier: 'community', basePrice: 0 },
  professional: { maxUsers: 25, storageGB: 100, certificationLevel: 'basic', features: ['basic_docs', 'chat', 'video', 'integrations'], supportTier: 'email', basePrice: 12 },
  business: { maxUsers: 100, storageGB: 500, certificationLevel: 'advanced', features: ['basic_docs', 'chat', 'video', 'integrations', 'sso', 'audit_log'], supportTier: 'priority', basePrice: 24 },
  enterprise: { maxUsers: -1, storageGB: -1, certificationLevel: 'premium', features: ['basic_docs', 'chat', 'video', 'integrations', 'sso', 'audit_log', 'data_residency', 'dedicated_infra'], supportTier: '24/7', basePrice: 45 },
};

const WORKSPACE_REGISTRY = [
  { id: 'WS-3001', name: 'Acme Engineering', plan: 'business', members: 72, usedStorageGB: 340, region: 'us-east-1', status: 'active' },
  { id: 'WS-3002', name: 'Globex Design', plan: 'professional', members: 18, usedStorageGB: 62, region: 'eu-west-1', status: 'active' },
  { id: 'WS-3003', name: 'Initech Labs', plan: 'starter', members: 4, usedStorageGB: 6, region: 'us-west-2', status: 'active' },
  { id: 'WS-3004', name: 'Umbrella Corp', plan: 'enterprise', members: 450, usedStorageGB: 2800, region: 'ap-northeast-1', status: 'active' },
];

const REGION_CONFIGS = {
  'us-east-1': { label: 'US East (Virginia)', latencyMs: 12, complianceZone: 'US', pricingMultiplier: 1.0 },
  'us-west-2': { label: 'US West (Oregon)', latencyMs: 18, complianceZone: 'US', pricingMultiplier: 1.0 },
  'eu-west-1': { label: 'EU West (Ireland)', latencyMs: 45, complianceZone: 'EU', pricingMultiplier: 1.15 },
  'ap-northeast-1': { label: 'Asia Pacific (Tokyo)', latencyMs: 68, complianceZone: 'APAC', pricingMultiplier: 1.2 },
};

const CERTIFICATION_REQUIREMENTS = {
  none: { auditFrequency: 'none', dataEncryption: 'at-rest', complianceScore: 0 },
  basic: { auditFrequency: 'annual', dataEncryption: 'at-rest-and-transit', complianceScore: 50 },
  advanced: { auditFrequency: 'quarterly', dataEncryption: 'at-rest-and-transit', complianceScore: 80 },
  premium: { auditFrequency: 'continuous', dataEncryption: 'end-to-end', complianceScore: 100 },
};

function resolveRegion(regionCode) {
  const config = REGION_CONFIGS[regionCode];
  if (!config) {
    return REGION_CONFIGS['us-east-1'];
  }
  return config;
}

function loadPlanConfiguration(planId) {
  const plan = WORKSPACE_PLANS[planId];
  if (!plan) {
    throw new Error(`Unknown workspace plan: ${planId}`);
  }
  return {
    workspace: {
      certificationLevel: plan.certificationLevel,
      maxUsers: plan.maxUsers,
      storageGB: plan.storageGB,
      supportTier: plan.supportTier,
      features: plan.features,
    },
    metadata: {
      planId,
      basePrice: plan.basePrice,
      lastUpdated: '2026-04-15',
    },
  };
}

function extractPlanFeatures(config) {
  const planConfig = config.workspace;
  return {
    certificationLevel: planConfig.certificationLevel,
    maxUsers: planConfig.maxUsers,
    storageGB: planConfig.storageGB,
    supportTier: planConfig.supportTier,
    featureCount: planConfig.features.length,
    features: planConfig.features,
  };
}

function computeWorkspaceQuota(planFeatures, teamSize, regionConfig) {
  const userCapacity = planFeatures.maxUsers === -1 ? teamSize : planFeatures.maxUsers;
  const utilizationPct = (teamSize / userCapacity) * 100;
  const certReqs = CERTIFICATION_REQUIREMENTS[planFeatures.certificationLevel];

  const storagePerUser = planFeatures.storageGB === -1
    ? 50
    : Math.floor(planFeatures.storageGB / userCapacity);

  return {
    totalCapacity: userCapacity,
    currentMembers: teamSize,
    utilizationPct: Math.min(100, parseFloat(utilizationPct.toFixed(1))),
    storagePerUserGB: storagePerUser,
    certification: {
      level: planFeatures.certificationLevel,
      auditFrequency: certReqs.auditFrequency,
      encryption: certReqs.dataEncryption,
      complianceScore: certReqs.complianceScore,
    },
    region: {
      label: regionConfig.label,
      latencyMs: regionConfig.latencyMs,
      complianceZone: regionConfig.complianceZone,
    },
  };
}

function buildInquiryResponse(workspaceName, planFeatures, quota, pricingInfo) {
  const isNearCapacity = quota.utilizationPct > 85;
  const upgradeRecommended = isNearCapacity || planFeatures.featureCount < 5;

  return {
    workspace: workspaceName,
    plan: {
      features: planFeatures.features,
      supportTier: planFeatures.supportTier,
      certificationLevel: planFeatures.certificationLevel,
    },
    capacity: {
      total: quota.totalCapacity,
      used: quota.currentMembers,
      utilizationPct: quota.utilizationPct,
      storagePerUserGB: quota.storagePerUserGB,
    },
    certification: quota.certification,
    region: quota.region,
    pricing: pricingInfo,
    recommendations: {
      upgradeRecommended,
      reason: isNearCapacity ? 'Workspace is near user capacity' : upgradeRecommended ? 'Limited feature set' : null,
    },
  };
}

async function processInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing workspace inquiry', {
    inquiryId,
    workspaceName: data.workspaceName,
    plan: data.plan,
    service: 'customer-d5fc3172-workspace',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const planConfig = loadPlanConfiguration(data.plan || 'business');
    const planFeatures = extractPlanFeatures(planConfig);
    const regionConfig = resolveRegion(data.region || 'us-east-1');
    const teamSize = data.teamSize || 50;

    const quota = computeWorkspaceQuota(planFeatures, teamSize, regionConfig);

    const monthlyPerUser = planConfig.metadata.basePrice * regionConfig.pricingMultiplier;
    const pricingInfo = {
      monthlyPerUser: parseFloat(monthlyPerUser.toFixed(2)),
      monthlyTotal: parseFloat((monthlyPerUser * teamSize).toFixed(2)),
      annualTotal: parseFloat((monthlyPerUser * teamSize * 12 * 0.85).toFixed(2)),
      currency: 'USD',
    };

    const response = buildInquiryResponse(data.workspaceName || 'Default Workspace', planFeatures, quota, pricingInfo);
    response.inquiryId = inquiryId;
    response.success = true;

    const duration = Date.now() - startTime;

    incrementMetric('workspace.inquiry.success', {
      route: '/api/d5fc3172/inquiry',
      plan: data.plan || 'business',
    });
    recordTiming('workspace.inquiry.latency', duration, {
      route: '/api/d5fc3172/inquiry',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('workspace.inquiry.failure', {
      route: '/api/d5fc3172/inquiry',
      errorClass: error.name,
    });
    recordTiming('workspace.inquiry.latency', duration, {
      route: '/api/d5fc3172/inquiry',
      error: 'true',
    });

    logger.error('Platform inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      workspaceName: data.workspaceName,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/d5fc3172/inquiry',
        service: 'customer-d5fc3172-workspace',
        plan: data.plan || 'business',
      },
      extra: { inquiryId, workspaceName: data.workspaceName, teamSize: data.teamSize },
    });

    createSessionAndAlert({
      customer: 'd5fc3172',
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
      tags: [
        { key: 'route', value: '/api/d5fc3172/inquiry' },
        { key: 'service', value: 'customer-d5fc3172-workspace' },
        { key: 'plan', value: data.plan || 'business' },
      ],
      extra: { inquiryId, workspaceName: data.workspaceName, teamSize: data.teamSize },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'acme-checkout@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from inquiry error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processInquiry, WORKSPACE_REGISTRY, WORKSPACE_PLANS };
