const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const LICENSE_TIERS = [
  { id: 'starter', label: 'Starter Suite', seatsIncluded: 10, pricePerSeat: 25, features: ['CRM', 'Email', 'Reports'] },
  { id: 'professional', label: 'Professional', seatsIncluded: 50, pricePerSeat: 80, features: ['CRM', 'Email', 'Reports', 'Forecasting', 'Pipeline'] },
  { id: 'enterprise', label: 'Enterprise', seatsIncluded: 200, pricePerSeat: 165, features: ['CRM', 'Email', 'Reports', 'Forecasting', 'Pipeline', 'Advanced Analytics', 'Sandbox'] },
  { id: 'unlimited', label: 'Unlimited', seatsIncluded: 500, pricePerSeat: 330, features: ['All Enterprise', 'Premier Support', 'Data Cloud', 'AI Agents'] },
];

const CLOUD_PRODUCTS = {
  sales: { name: 'Sales Cloud', monthlyBase: 25, category: 'revenue' },
  service: { name: 'Service Cloud', monthlyBase: 25, category: 'support' },
  marketing: { name: 'Marketing Cloud', monthlyBase: 1250, category: 'engagement' },
  commerce: { name: 'Commerce Cloud', monthlyBase: 50, category: 'revenue' },
  data: { name: 'Data Cloud', monthlyBase: 0, category: 'platform' },
  agentforce: { name: 'Agentforce', monthlyBase: 2, category: 'ai', unit: 'conversation' },
};

const REGION_MULTIPLIERS = {
  americas: { factor: 1.0, currency: 'USD', taxRate: 0.0875 },
  emea: { factor: 1.15, currency: 'EUR', taxRate: 0.20 },
  apac: { factor: 0.92, currency: 'USD', taxRate: 0.10 },
  japan: { factor: 1.08, currency: 'JPY', taxRate: 0.10 },
};

function resolveTier(tierId) {
  return LICENSE_TIERS.find((t) => t.id === tierId);
}

function buildProductBundle(productKeys) {
  const items = [];
  for (const key of productKeys) {
    const product = CLOUD_PRODUCTS[key];
    if (product) {
      items.push({
        key,
        name: product.name,
        monthlyBase: product.monthlyBase,
        category: product.category,
        unit: product.unit || 'user',
      });
    }
  }
  return items;
}

function calculatePricing(tier, bundle, region, seatCount) {
  const regionConfig = REGION_MULTIPLIERS[region];
  const baseSeatCost = tier.pricePerSeat * seatCount * regionConfig.factor;

  const bundleCosts = bundle.map((item) => {
    const itemCost = item.monthlyBase * regionConfig.factor;
    return {
      product: item.name,
      monthlyCost: Math.round(itemCost * 100) / 100,
      unit: item.unit,
    };
  });

  const totalBundleMonthly = bundleCosts.reduce((sum, b) => sum + b.monthlyCost, 0);
  const monthlyTotal = baseSeatCost + totalBundleMonthly;
  const annualSubtotal = monthlyTotal * 12;
  const taxAmount = annualSubtotal * regionConfig.taxRate;

  return {
    tier: tier.label,
    seatCount,
    pricePerSeat: Math.round(tier.pricePerSeat * regionConfig.factor * 100) / 100,
    seatSubtotal: Math.round(baseSeatCost * 100) / 100,
    products: bundleCosts,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
    annualSubtotal: Math.round(annualSubtotal * 100) / 100,
    tax: Math.round(taxAmount * 100) / 100,
    annualTotal: Math.round((annualSubtotal + taxAmount) * 100) / 100,
    currency: regionConfig.currency,
  };
}

function generateProvisioningPlan(pricing, tier, bundle) {
  const plan = {
    instances: [],
    dataAllocation: {},
    aiCredits: 0,
  };

  for (const item of bundle) {
    plan.instances.push({
      product: item.product,
      edition: tier.label,
      status: 'pending_provision',
    });
  }

  const storagePerSeat = tier.id === 'unlimited' ? 20 : tier.id === 'enterprise' ? 10 : 5;
  plan.dataAllocation.storageGb = pricing.seatCount * storagePerSeat;
  plan.dataAllocation.apiCallsDaily = pricing.seatCount * 1000;

  const aiProduct = bundle.find((b) => b.unit === 'conversation');
  if (aiProduct) {
    plan.aiCredits = pricing.seatCount * 250;
  }

  return plan;
}

function buildInquiryResponse(pricing, provisionPlan, region) {
  const regionConfig = REGION_MULTIPLIERS[region];
  const summary = {
    region: region.toUpperCase(),
    currency: regionConfig.currency,
    pricing,
    provisioning: provisionPlan,
    estimatedDeploymentDays: provisionPlan.instances.length * 3 + 7,
    supportTier: pricing.tier === 'Unlimited' ? 'Premier' : 'Standard',
  };

  summary.readinessScore = calculateReadiness(provisionPlan);
  summary.complianceCert = provisionPlan.governance.certificationLevel;
  return summary;
}

function calculateReadiness(provisionPlan) {
  let score = 100;
  const instanceCount = provisionPlan.instances.length;
  if (instanceCount > 5) score -= 15;
  if (provisionPlan.dataAllocation.storageGb > 5000) score -= 10;
  if (provisionPlan.aiCredits > 0) score += 5;
  return Math.max(0, Math.min(100, score));
}

async function processInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing platform inquiry', {
    inquiryId,
    tier: data.tier,
    region: data.region,
    products: data.products,
    service: 'customer-b3e22436-crm',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const tier = resolveTier(data.tier || 'enterprise');
    const bundle = buildProductBundle(data.products || ['sales', 'service', 'agentforce']);
    const seatCount = data.seats || 150;
    const region = data.region || 'americas';

    const pricing = calculatePricing(tier, bundle, region, seatCount);
    const provisionPlan = generateProvisioningPlan(pricing, tier, bundle);
    const response = buildInquiryResponse(pricing, provisionPlan, region);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/b3e22436/inquiry',
      tier: data.tier,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/b3e22436/inquiry',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/b3e22436/inquiry',
      errorClass: error.name,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/b3e22436/inquiry',
      error: 'true',
    });

    logger.error('Platform inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      tier: data.tier,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b3e22436/inquiry',
        service: 'customer-b3e22436-crm',
        tier: data.tier,
      },
      extra: { inquiryId, tier: data.tier, region: data.region },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b3e22436.js \u2014 processInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-b3e22436-crm',
      verticalLabel: 'Platform Inquiry',
      customer: 'b3e22436',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/b3e22436/inquiry' },
        { key: 'service', value: 'customer-b3e22436-crm' },
        { key: 'tier', value: data.tier },
      ],
      extra: { inquiryId, tier: data.tier, region: data.region },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-b3e22436-crm@2.1.0',
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

module.exports = { processInquiry, LICENSE_TIERS, CLOUD_PRODUCTS };
