const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/softwarequote/quote';

/**
 * Software catalog sold through the Commerce Portal. Prices are annual list
 * prices in USD per seat.
 */
const PRODUCTS = {
  '9324-RLD300SUBENE': { name: 'Studio 5000 Logix Designer Standard Edition', family: 'Studio 5000', type: 'subscription', annualUsd: 1670.89 },
  '9324-RLDGLXSUBENE': { name: 'Studio 5000 GuardLogix Safety Editor (add-on)', family: 'Studio 5000', type: 'add-on', annualUsd: 288.12 },
  '9541-OPXSTDPROSUB': { name: 'FactoryTalk Optix Studio Pro', family: 'FactoryTalk Optix', type: 'subscription', annualUsd: 2450.0 },
  '9701-VWSTDSUBENE': { name: 'FactoryTalk View Studio Site Edition', family: 'FactoryTalk View', type: 'subscription', annualUsd: 1190.0 },
  'TC-SW-STD-SUB': { name: 'TechConnect Standard Support', family: 'Support', type: 'support', annualUsd: 0 },
};

/**
 * Agreement terms offered at checkout and the pricing condition each one is
 * quoted under.
 */
const AGREEMENT_TERMS = {
  ANNUAL_1Y: { label: '1 year, billed annually', years: 1, billing: 'annual', pricingCondition: 'ZA01' },
  ANNUAL_3Y: { label: '3 years, billed annually', years: 3, billing: 'annual', pricingCondition: 'ZA03' },
  PREPAID_3Y: { label: '3 years, prepaid', years: 3, billing: 'prepaid', pricingCondition: 'ZPP3' },
};

/**
 * Pricing conditions synced from the price master. Discounts apply to the
 * annual list price for every year of the term.
 */
const PRICING_CONDITIONS = {
  ZA01: { description: 'Subscription list, annual billing', discountPct: 0 },
  ZA03: { description: 'Multi-year commitment, annual billing', discountPct: 5 },
};

const QUOTE_VALID_DAYS = 30;

function roundUsd(value) {
  return Math.round(value * 100) / 100;
}

function quoteLine(item, term) {
  const catalog = String(item.catalog || '').toUpperCase();
  const product = PRODUCTS[catalog];
  if (!product) {
    const error = new Error(`Catalog number not orderable: ${catalog}`);
    error.code = 'PRODUCT_NOT_FOUND';
    throw error;
  }
  const quantity = Math.max(1, Math.min(999, parseInt(item.quantity, 10) || 1));
  const condition = PRICING_CONDITIONS[term.pricingCondition];
  const annualNet = roundUsd(product.annualUsd * quantity * (1 - condition.discountPct / 100));
  return {
    catalog,
    name: product.name,
    quantity,
    annualListUsd: roundUsd(product.annualUsd * quantity),
    discountPct: condition.discountPct,
    annualNetUsd: annualNet,
    termNetUsd: roundUsd(annualNet * term.years),
  };
}

/**
 * Generate a priced quote for the items in the cart under the selected
 * agreement term.
 */
async function generateQuote(request, options = {}) {
  const startTime = Date.now();
  const quoteRequestId = uuidv4();
  const termId = String(request.agreementTerm || 'ANNUAL_1Y').toUpperCase();
  const items = Array.isArray(request.items) ? request.items.slice(0, 25) : [];
  const customerPo = request.customerPo ? String(request.customerPo).slice(0, 35) : null;
  const country = String(request.country || 'US').toUpperCase().slice(0, 2);

  logger.info('Software quote requested', {
    quoteRequestId, agreementTerm: termId, lines: items.length, country, service: 'commerce-quote-api', route: ROUTE,
  });

  try {
    const term = AGREEMENT_TERMS[termId];
    if (!term) {
      const error = new Error(`Unknown agreement term: ${termId}`);
      error.code = 'INVALID_TERM';
      throw error;
    }
    if (!items.length) {
      const error = new Error('Cart is empty');
      error.code = 'EMPTY_CART';
      throw error;
    }

    const lines = items.map((item) => quoteLine(item, term));
    const annualNetUsd = roundUsd(lines.reduce((sum, l) => sum + l.annualNetUsd, 0));
    const termNetUsd = roundUsd(lines.reduce((sum, l) => sum + l.termNetUsd, 0));
    const dueAtOrderUsd = term.billing === 'prepaid' ? termNetUsd : annualNetUsd;
    const quoteNumber = `Q-${String(Date.now()).slice(-8)}`;
    const validUntil = new Date(Date.now() + QUOTE_VALID_DAYS * 86400000).toISOString().slice(0, 10);
    const duration = Date.now() - startTime;

    incrementMetric('softwarequote.quote.success', { route: ROUTE, term: termId });
    recordTiming('softwarequote.quote.latency', duration, { route: ROUTE });

    return {
      success: true,
      quoteRequestId,
      quoteNumber,
      status: 'QUOTE',
      agreementTerm: termId,
      termLabel: term.label,
      currency: 'USD',
      customerPo,
      lines,
      annualNetUsd,
      termNetUsd,
      dueAtOrderUsd,
      validUntil,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('softwarequote.quote.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('softwarequote.quote.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Software quote failed', {
      quoteRequestId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, agreementTerm: termId, lines: items.length,
    });
    if (!['INVALID_TERM', 'EMPTY_CART', 'PRODUCT_NOT_FOUND'].includes(error.code)) {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'commerce-quote-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { quoteRequestId, agreementTerm: termId, lines: items.length, country },
      });
    }
    throw error;
  }
}

module.exports = { generateQuote, PRODUCTS, AGREEMENT_TERMS, PRICING_CONDITIONS };
