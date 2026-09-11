const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/ce4ebc10/publish-pricing';
const SERVICE = 'zuora-usage-pricing';

const PRICING_MODELS = {
  usage: {
    label: 'Usage',
    description: 'Metered consumption billed as it occurs',
    billingRule: 'usage_event_metering',
  },
  hybrid: {
    label: 'Hybrid',
    description: 'Usage + prepaid credits + committed spend',
    billingRule: 'prepaid_credit_drawdown',
  },
  flat: {
    label: 'Flat',
    description: 'Fixed fee recognized across the contract term',
    billingRule: 'flat_recurring_charge',
  },
};

const ACCOUNTS = {
  'acct-4471': {
    name: 'Acme Corp',
    contractId: 'CT-2026-0917',
    committedSpend: 50000,
    prepaidCreditPct: 65,
    currency: 'USD',
  },
  'acct-8820': {
    name: 'Northstar Labs',
    contractId: 'CT-2026-0882',
    committedSpend: 25000,
    prepaidCreditPct: 35,
    currency: 'USD',
  },
  'acct-1934': {
    name: 'Pioneer Health',
    contractId: 'CT-2026-0741',
    committedSpend: 0,
    prepaidCreditPct: 0,
    currency: 'USD',
  },
};

const REV_REC_TREATMENTS = {
  usage_ratable: {
    recognitionMethod: 'ratable_over_usage_period',
    performanceObligation: 'consumption',
    scheduleMonths: 5,
  },
  flat_over_term: {
    recognitionMethod: 'straight_line',
    performanceObligation: 'stand_ready',
    scheduleMonths: 5,
  },
  flat_point_in_time: {
    recognitionMethod: 'point_in_time',
    performanceObligation: 'license_delivery',
    scheduleMonths: 1,
  },
};

function rateUsage(model, ratePerToken, usageTokens) {
  const amount = Math.round(ratePerToken * usageTokens * 100) / 100;
  return {
    model,
    description: `${usageTokens.toLocaleString('en-US')} tokens at $${ratePerToken}/token`,
    quantity: usageTokens,
    unit: 'token',
    unitRate: ratePerToken,
    amount,
    invoiceNumber: 'INV-2048',
  };
}

function mapUsageToBilling(account, invoiceLine) {
  return {
    accountId: Object.keys(ACCOUNTS).find((id) => ACCOUNTS[id] === account) || null,
    accountName: account.name,
    contractId: account.contractId,
    billingRule: 'usage_event_metering',
    invoiceLine,
  };
}

/**
 * Resolves the revenue treatment for a pricing model and account.
 *
 * BUG: the hybrid drawdown treatment was added to the pricing catalog/UI but
 * never registered in REV_REC_TREATMENTS.
 */
function resolveRevenueTreatment(model, account) {
  if (model === 'hybrid' && account.prepaidCreditPct > 0) return 'hybrid_drawdown';
  if (model === 'flat') return 'flat_over_term';
  return 'usage_ratable';
}

function validateRevenueImpact(invoiceLine, treatmentCode) {
  const treatment = REV_REC_TREATMENTS[treatmentCode];
  const recognitionMethod = treatment.recognitionMethod;
  return {
    treatment: treatmentCode,
    recognitionMethod,
    performanceObligation: treatment.performanceObligation,
    scheduleMonths: treatment.scheduleMonths,
    invoiceAmount: invoiceLine.amount,
  };
}

function buildSchedule(amount, months) {
  const base = Math.floor((amount / months) * 100) / 100;
  const schedule = [];
  let allocated = 0;
  for (let index = 0; index < months; index += 1) {
    const bucketAmount = index === months - 1
      ? Math.round((amount - allocated) * 100) / 100
      : base;
    allocated += bucketAmount;
    schedule.push({
      month: index + 1,
      amount: bucketAmount,
    });
  }
  return schedule;
}

async function publishPricing(data) {
  const startTime = Date.now();
  const publishId = uuidv4();

  logger.info('Publishing Zuora AI usage pricing', {
    publishId,
    pricingModel: data.pricingModel,
    accountId: data.accountId,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const model = data.pricingModel || 'hybrid';
    const account = ACCOUNTS[data.accountId || 'acct-4471'];
    const ratePerToken = data.ratePerToken === undefined ? 0.002 : data.ratePerToken;
    const usageTokens = data.usageTokens === undefined ? 1240000 : data.usageTokens;
    const invoiceLine = rateUsage(model, ratePerToken, usageTokens);
    const billing = mapUsageToBilling(account, invoiceLine);
    const treatment = resolveRevenueTreatment(model, account);
    const revenueImpact = validateRevenueImpact(invoiceLine, treatment);
    const duration = Date.now() - startTime;

    incrementMetric('pricing.publish.success', { route: ROUTE, pricingModel: model });
    recordTiming('pricing.publish.latency', duration, { route: ROUTE });

    return {
      success: true,
      publishId,
      pricingModel: model,
      invoice: {
        invoiceNumber: invoiceLine.invoiceNumber,
        amount: invoiceLine.amount,
        currency: account.currency,
        quantity: invoiceLine.quantity,
        unitRate: invoiceLine.unitRate,
        accountId: billing.accountId,
        accountName: billing.accountName,
        contractId: billing.contractId,
      },
      revenue: {
        treatment: revenueImpact.treatment,
        recognitionMethod: revenueImpact.recognitionMethod,
        performanceObligation: revenueImpact.performanceObligation,
        schedule: buildSchedule(invoiceLine.amount, revenueImpact.scheduleMonths),
      },
      checks: ['Pricing model valid', 'Billing rule mapped', 'Revenue tie-out clean'],
      status: 'published',
      publishedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('pricing.publish.failure', {
      route: ROUTE,
      errorClass: error.name,
      pricingModel: data.pricingModel,
    });
    recordTiming('pricing.publish.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Zuora AI pricing publish failed', {
      publishId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      pricingModel: data.pricingModel,
      accountId: data.accountId,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'zuora-ai-pricing' },
      extra: {
        publishId,
        pricingModel: data.pricingModel,
        accountId: data.accountId,
        usageTokens: data.usageTokens,
      },
    });

    declareDatadogIncident({
      title: 'Zuora AI pricing publish failing for hybrid usage plans',
      summary: `${error.name}: ${error.message}. Hybrid (usage + prepaid credit) pricing models cannot be published; revenue tie-out fails.`,
      runRef: publishId,
      service: SERVICE,
      triggeredBy: data.devinEmail || 'zuora-ai',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((err) => logger.warn('Failed to declare Datadog incident for Zuora AI pricing', { error: err.message, publishId }));

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ce4ebc10.js — validateRevenueImpact',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'ce4ebc10',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Zuora — AI Usage-Based Pricing',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        publishId,
        pricingModel: data.pricingModel,
        accountId: data.accountId,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Zuora pricing error', { error: err.message, publishId });
    });

    throw error;
  }
}

module.exports = {
  publishPricing,
  rateUsage,
  mapUsageToBilling,
  resolveRevenueTreatment,
  validateRevenueImpact,
  buildSchedule,
  PRICING_MODELS,
  ACCOUNTS,
  REV_REC_TREATMENTS,
};
