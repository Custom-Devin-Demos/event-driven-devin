const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/bookbuild/orders';

/**
 * Live ECM deals open for bookbuild, keyed by deal id.
 */
const DEALS = new Map([
  ['CSR-PLC-2611', {
    issuer: 'Coastline Resources', ticker: 'CSR', structure: 'Institutional placement',
    sizeAud: 450e6, offerPrice: 3.85, floorPrice: 3.70,
  }],
  ['SXH-IPO-2611', {
    issuer: 'Southern Cross Healthcare', ticker: 'SXH', structure: 'IPO \u2014 institutional offer',
    sizeAud: 1.2e9, offerPrice: 2.40, floorPrice: 2.25,
  }],
]);

/**
 * Institutional investor accounts as synced from the client master.
 * `jurisdiction` selects the offer's selling restriction in SELLING_RESTRICTIONS.
 */
const INVESTORS = new Map([
  ['HPS-AU-0042', { name: 'Harbour Point Super', type: 'Super fund', jurisdiction: 'AU' }],
  ['KRC-NZ-0117', { name: 'Kauri Ridge Capital', type: 'Long only', jurisdiction: 'NZ' }],
  ['TRA-UK-0088', { name: 'Thames Reach Asset Management', type: 'Long only', jurisdiction: 'UK' }],
  ['LPC-HK-0193', { name: 'Lantau Peak Capital', type: 'Hedge fund', jurisdiction: 'HK-PI' }],
  ['MBI-SG-0071', { name: 'Marina Bay Investments', type: 'Sovereign wealth', jurisdiction: 'SG' }],
  ['GLE-US-0205', { name: 'Great Lakes Equity Partners', type: 'Long only', jurisdiction: 'US' }],
]);

/**
 * Offer-document selling restrictions per investor jurisdiction.
 */
const SELLING_RESTRICTIONS = {
  AU: { investorTest: 's708 sophisticated / professional', wallCrossRequired: false },
  NZ: { investorTest: 'Wholesale investor (FMCA Sch 1 cl 3)', wallCrossRequired: false },
  UK: { investorTest: 'Qualified investor (UK Prospectus Reg. art 2(e))', wallCrossRequired: true },
  HK: { investorTest: 'Professional investor (SFO Sch 1 Pt 1)', wallCrossRequired: true },
  SG: { investorTest: 'Institutional investor (SFA s274)', wallCrossRequired: true },
  US: { investorTest: 'QIB (Rule 144A) / Reg S offshore', wallCrossRequired: true },
};

function rejectOrder(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Enter an institutional order into a live bookbuild after checking the
 * investor's selling restriction for the offer.
 */
async function enterOrder(order, options = {}) {
  const startTime = Date.now();
  const orderId = uuidv4();
  const dealId = String(order.dealId || '');
  const investorId = String(order.investorId || '').toUpperCase();
  const demandAud = Number(order.demandAud);
  const orderType = order.orderType === 'limit' ? 'limit' : 'strike';
  const limitPrice = orderType === 'limit' ? Number(order.limitPrice) : null;

  logger.info('Bookbuild order entry', {
    orderId, dealId, investorId, orderType, service: 'ecm-bookbuild-api', route: ROUTE,
  });

  try {
    const deal = DEALS.get(dealId);
    if (!deal) throw rejectOrder('DEAL_NOT_FOUND', `Deal ${dealId} is not open for bookbuild.`);
    const investor = INVESTORS.get(investorId);
    if (!investor) throw rejectOrder('INVESTOR_NOT_FOUND', `Investor account ${investorId} is not in the client master.`);
    if (!Number.isFinite(demandAud) || demandAud <= 0) {
      throw rejectOrder('INVALID_ORDER', 'Enter the demand in A$m.');
    }
    if (orderType === 'limit' && !(limitPrice >= deal.floorPrice)) {
      throw rejectOrder('INVALID_ORDER', `Limit must be at or above the A$${deal.floorPrice.toFixed(2)} floor.`);
    }

    const restriction = SELLING_RESTRICTIONS[investor.jurisdiction];
    const eligibility = {
      investorTest: restriction.investorTest,
      wallCrossRequired: restriction.wallCrossRequired,
    };
    const shares = Math.floor((demandAud * 1e6) / (limitPrice || deal.offerPrice));
    const duration = Date.now() - startTime;

    incrementMetric('bookbuild.order.success', { route: ROUTE });
    recordTiming('bookbuild.order.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId,
      dealId,
      issuer: deal.issuer,
      investorId,
      investor: investor.name,
      investorType: investor.type,
      jurisdiction: investor.jurisdiction,
      demandAud,
      orderType,
      limitPrice,
      shares,
      eligibility,
      status: 'IN_BOOK',
      enteredAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('bookbuild.order.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('bookbuild.order.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Bookbuild order entry failed', {
      orderId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, dealId, investorId,
    });
    if (!error.code) {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'ecm-bookbuild-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { orderId, dealId, investorId },
      });
    }
    throw error;
  }
}

module.exports = { enterOrder, DEALS, INVESTORS };
