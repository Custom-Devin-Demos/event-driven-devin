const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Plan configurations for Cognition Japan sales inquiries.
 *
 * Keys are the plan identifiers sent by the frontend contact form.
 * The frontend sends plan IDs like "Starter", "Business", "Enterprise".
 *
 * BUG (now fixed): The original map only contained lowercase keys
 * ("starter", "business") and omitted "Enterprise" entirely.
 * The frontend sends the plan ID as-is (e.g. "Enterprise"), so the
 * lookup failed with: Error: 不明なプランID: Enterprise
 *
 * FIX: Added "Enterprise" to the map so the lookup succeeds.
 */
const PLAN_CONFIGS = {
  Starter: {
    nameJa: 'スターター',
    seats: 10,
    pricePerSeat: 1500,
    currency: 'JPY',
    features: ['basic-support', 'single-workspace'],
    slaHours: 48,
    tier: 1,
  },
  Business: {
    nameJa: 'ビジネス',
    seats: 50,
    pricePerSeat: 1200,
    currency: 'JPY',
    features: ['basic-support', 'multi-workspace', 'analytics'],
    slaHours: 24,
    tier: 2,
  },
  Enterprise: {
    nameJa: 'エンタープライズ',
    seats: -1,
    pricePerSeat: 900,
    currency: 'JPY',
    features: ['priority-support', 'multi-workspace', 'analytics', 'sso', 'audit-log', 'dedicated-csm'],
    slaHours: 4,
    tier: 3,
  },
};

/**
 * Recent contact-sales inquiries for the demo dashboard.
 */
const RECENT_INQUIRIES = [
  { id: 'INQ-JP-001', company: '株式会社テクノロジーズ', contact: '田中太郎', plan: 'Enterprise', seats: 200, status: 'pending', createdAt: '2026-03-28' },
  { id: 'INQ-JP-002', company: 'グローバルシステムズ', contact: '佐藤花子', plan: 'Business', seats: 30, status: 'contacted', createdAt: '2026-03-25' },
  { id: 'INQ-JP-003', company: 'デジタルソリューションズ', contact: '鈴木一郎', plan: 'Starter', seats: 10, status: 'closed-won', createdAt: '2026-03-20' },
  { id: 'INQ-JP-004', company: 'AIイノベーション株式会社', contact: '高橋美咲', plan: 'Enterprise', seats: 500, status: 'pending', createdAt: '2026-03-30' },
];

/**
 * Resolve plan configuration for the given plan ID.
 *
 * @param {string} planId - Plan identifier (e.g. "Enterprise")
 * @returns {Object} Plan config
 * @throws {Error} If the plan ID is not found
 */
function resolvePlan(planId) {
  const config = PLAN_CONFIGS[planId];
  if (!config) {
    throw new Error(`不明なプランID: ${planId}`);
  }
  return config;
}

/**
 * Compute a price estimate for the contact-sales inquiry.
 */
function computeEstimate(planConfig, seats) {
  const monthlyTotal = seats * planConfig.pricePerSeat;
  const annualTotal = monthlyTotal * 12 * 0.85; // 15% annual discount
  return {
    monthly: monthlyTotal,
    annual: Math.round(annualTotal),
    currency: planConfig.currency,
    discount: '15%',
  };
}

/**
 * Format the sales inquiry response.
 */
function formatInquiryResponse(inquiryId, data, planConfig, estimate) {
  return {
    inquiryId,
    company: data.company,
    contact: data.contact,
    email: data.email,
    plan: data.planId,
    planNameJa: planConfig.nameJa,
    seats: data.seats,
    features: planConfig.features,
    slaHours: planConfig.slaHours,
    estimate,
    status: 'received',
    message: 'お問い合わせありがとうございます。担当者より2営業日以内にご連絡いたします。',
  };
}

/**
 * Process a contact-sales inquiry.
 *
 * Validates the requested plan, computes a price estimate, and returns
 * a confirmation. This is the primary action for the cognition-japan vertical.
 */
async function processContactSales(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing contact-sales inquiry', {
    inquiryId,
    company: data.company,
    planId: data.planId,
    seats: data.seats,
    service: 'cognition-japan-sales',
  });

  try {
    // Simulate CRM API latency
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const planConfig = resolvePlan(data.planId);
    const estimate = computeEstimate(planConfig, data.seats);
    const response = formatInquiryResponse(inquiryId, data, planConfig, estimate);

    const duration = Date.now() - startTime;

    incrementMetric('contactsales.success', {
      route: '/api/cognition-japan/contact-sales',
      plan: data.planId,
    });
    recordTiming('contactsales.latency', duration, {
      route: '/api/cognition-japan/contact-sales',
    });

    return {
      success: true,
      ...response,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('contactsales.failure', {
      route: '/api/cognition-japan/contact-sales',
      errorClass: error.name,
      plan: data.planId,
    });
    recordTiming('contactsales.latency', duration, {
      route: '/api/cognition-japan/contact-sales',
      error: 'true',
    });

    logger.error('Contact-sales inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      company: data.company,
      planId: data.planId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/cognition-japan/contact-sales',
        service: 'cognition-japan-sales',
        plan: data.planId,
      },
      extra: {
        inquiryId,
        company: data.company,
        seats: data.seats,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/cognition-japan.js — processContactSales',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      service: 'cognition-japan-sales',
      verticalLabel: 'Cognition Japan Sales',
      customer: 'cognition-japan',
      tags: [
        { key: 'route', value: '/api/cognition-japan/contact-sales' },
        { key: 'service', value: 'cognition-japan-sales' },
        { key: 'plan', value: data.planId },
      ],
      extra: { inquiryId, company: data.company, seats: data.seats },
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
      logger.error('Failed to trigger Devin session from contact-sales error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processContactSales, RECENT_INQUIRIES, PLAN_CONFIGS };
