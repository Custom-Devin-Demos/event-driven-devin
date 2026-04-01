const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const PLAN_TIERS = {
  starter: { label: 'スターター', seats: 5, pricePerSeat: 49, features: ['basic_agent', 'slack_integration'] },
  professional: { label: 'プロフェッショナル', seats: 25, pricePerSeat: 99, features: ['advanced_agent', 'slack_integration', 'jira_integration', 'deepwiki'] },
  enterprise: { label: 'エンタープライズ', seats: 100, pricePerSeat: 199, features: ['advanced_agent', 'slack_integration', 'jira_integration', 'deepwiki', 'dedicated_saas', 'sso'] },
};

const REGION_MULTIPLIERS = {
  'ap-northeast-1': { region: '東京', factor: 1.15, currency: 'JPY', exchangeRate: 149.5 },
  'ap-northeast-3': { region: '大阪', factor: 1.12, currency: 'JPY', exchangeRate: 149.5 },
  'ap-southeast-1': { region: 'シンガポール', factor: 1.08, currency: 'SGD', exchangeRate: 1.35 },
  'us-east-1': { region: 'バージニア', factor: 1.0, currency: 'USD', exchangeRate: 1.0 },
};

const COMPLIANCE_REQUIREMENTS = [
  { code: 'SOC2', label: 'SOC 2 Type II', weight: 0.3 },
  { code: 'ISO27001', label: 'ISO/IEC 27001', weight: 0.25 },
  { code: 'ISMAP', label: 'ISMAP', weight: 0.2 },
  { code: 'FISC', label: 'FISC安全対策基準', weight: 0.15 },
  { code: 'APPI', label: '個人情報保護法', weight: 0.1 },
];

function resolveRegionConfig(regionCode) {
  const config = REGION_MULTIPLIERS[regionCode];
  if (!config) {
    return REGION_MULTIPLIERS['ap-northeast-1'];
  }
  return {
    regionName: config.region,
    pricingFactor: config.factor,
    currencyCode: config.currency,
    rate: config.exchangeRate,
  };
}

function calculatePlanPricing(planId, seatCount, regionConfig) {
  const plan = PLAN_TIERS[planId];
  if (!plan) {
    throw new Error(`不明なプランID: ${planId}`);
  }

  const basePrice = plan.pricePerSeat * seatCount;
  const regionAdjusted = basePrice * regionConfig.pricingFactor;
  const localPrice = regionAdjusted * regionConfig.rate;

  return {
    planLabel: plan.label,
    seats: seatCount,
    baseUSD: basePrice,
    adjustedUSD: regionAdjusted,
    localAmount: Math.round(localPrice),
    currency: regionConfig.currencyCode,
    features: plan.features,
  };
}

function evaluateCompliance(requestedCodes) {
  const results = requestedCodes.map((code) => {
    const req = COMPLIANCE_REQUIREMENTS.find((c) => c.code === code);
    return req ? { code: req.code, label: req.label, status: 'certified', weight: req.weight } : null;
  });

  const validResults = results.filter(Boolean);
  const complianceScore = validResults.reduce((sum, r) => sum + r.weight, 0);

  return {
    items: validResults,
    score: complianceScore,
    meetsThreshold: complianceScore >= 0.7,
  };
}

function buildContactSummary(contactInfo, pricing, compliance) {
  const quoteId = uuidv4().split('-')[0].toUpperCase();

  const summary = {
    quoteId,
    contact: {
      name: `${contactInfo.lastName} ${contactInfo.firstName}`,
      email: contactInfo.email,
      company: contactInfo.company,
      title: contactInfo.jobTitle,
    },
    plan: {
      name: pricing.planLabel,
      seats: pricing.seats,
      monthlyLocal: pricing.localAmount,
      currency: pricing.currency,
      annualLocal: pricing.localAmount * 12,
    },
    compliance: {
      score: compliance.score,
      certified: compliance.items.map((i) => i.label),
      qualified: compliance.meetsThreshold,
    },
    generatedAt: new Date().toISOString(),
  };

  if (!compliance.meetsThreshold) {
    summary.notes = 'コンプライアンス要件が基準を満たしていません。追加認証が必要です。';
  }

  return summary;
}

async function processContactSales(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing contact sales request', {
    requestId,
    email: data.email,
    company: data.company,
    service: 'cognition-japan-sales',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const regionConfig = resolveRegionConfig(data.region || 'ap-northeast-1');
    const pricing = calculatePlanPricing(
      data.plan || 'enterprise',
      data.seats || 50,
      regionConfig,
    );

    const complianceCodes = data.compliance || ['SOC2', 'ISO27001', 'ISMAP'];
    const compliance = evaluateCompliance(complianceCodes);

    const summary = buildContactSummary(data, pricing, compliance);
    summary.requestId = requestId;

    const duration = Date.now() - startTime;

    incrementMetric('contact_sales.success', {
      route: '/api/cognition-japan/contact-sales',
      plan: data.plan || 'enterprise',
    });
    recordTiming('contact_sales.latency', duration, {
      route: '/api/cognition-japan/contact-sales',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('contact_sales.failure', {
      route: '/api/cognition-japan/contact-sales',
      errorClass: error.name,
    });
    recordTiming('contact_sales.latency', duration, {
      route: '/api/cognition-japan/contact-sales',
      error: 'true',
    });

    logger.error('Contact sales processing failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      email: data.email,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/cognition-japan/contact-sales',
        service: 'cognition-japan-sales',
        region: data.region || 'ap-northeast-1',
      },
      extra: { requestId, email: data.email, company: data.company },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/cognition-japan.js \u2014 processContactSales',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinOrgId: 'org-9a7c9b33de89435997ca87264e9a9403',
      devinUserId: 'email|6877f32ae1279dd720593f93',
      service: 'cognition-japan-sales',
      verticalLabel: '\u304A\u554F\u3044\u5408\u308F\u305B\u51E6\u7406\u30A8\u30E9\u30FC',
      language: 'ja',
      tags: [
        { key: 'route', value: '/api/cognition-japan/contact-sales' },
        { key: 'service', value: 'cognition-japan-sales' },
      ],
      extra: { requestId, email: data.email, company: data.company },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'cognition-japan-sales@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('\u30C7\u30D3\u30F3\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u4F5C\u6210\u306B\u5931\u6557\u3057\u307E\u3057\u305F', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processContactSales, PLAN_TIERS, REGION_MULTIPLIERS };
