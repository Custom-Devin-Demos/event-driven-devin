const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Lines a Cardinal Health Market customer can submit from the order review
 * page. The `storageClass` is the join key into the handling rules below.
 */
const ORDER_LINES = [
  {
    code: 'vaccine-refrigerated',
    name: 'Influenza vaccine, quadrivalent \u2014 10 x 0.5 mL syringe',
    identifier: 'NDC 49281-0421-10',
    quantity: 24,
    unitOfMeasure: 'carton',
    extendedPriceUsd: 1284.0,
    storageClass: 'cold_chain_2_8c',
  },
  {
    code: 'exam-gloves',
    name: 'Cardinal Health\u2122 nitrile exam gloves, large',
    identifier: 'SKU 88TT2103',
    quantity: 30,
    unitOfMeasure: 'case',
    extendedPriceUsd: 742.5,
    storageClass: 'ambient_med_surg',
  },
  {
    code: 'controlled-c2',
    name: 'Hydromorphone HCl injection, 2 mg/mL',
    identifier: 'NDC 00409-1312-01',
    quantity: 5,
    unitOfMeasure: 'carton',
    extendedPriceUsd: 418.75,
    storageClass: 'controlled_schedule_ii',
  },
];

/**
 * Handling rules per storage class: transit time out of the distribution
 * center, the packaging surcharge, and the dock requirements the driver has to
 * satisfy. Every order line's `storageClass` must be registered here.
 */
const HANDLING_RULES = {
  ambient_med_surg: {
    label: 'Ambient med-surg',
    transitLeadTimeDays: 2,
    packagingSurchargeUsd: 0,
    requiresSignature: false,
    dockInstruction: 'Standard pallet drop at Dock B',
  },
  controlled_schedule_ii: {
    label: 'DEA Schedule II vault',
    transitLeadTimeDays: 3,
    packagingSurchargeUsd: 24.0,
    requiresSignature: true,
    dockInstruction: 'Vault-to-vault transfer, DEA Form 222 signature required',
  },
};

/**
 * Contract tiers available to the account, with the share of freight and
 * packaging surcharges waived at submission.
 */
const CONTRACT_TIERS = {
  novaplus: { label: 'Novaplus\u00ae \u2014 Vizient', surchargeWaivedPct: 100 },
  'gpo-premier': { label: 'Premier GPO', surchargeWaivedPct: 50 },
  'idn-direct': { label: 'IDN direct agreement', surchargeWaivedPct: 25 },
  'list-price': { label: 'List price', surchargeWaivedPct: 0 },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Cardinal Health Market ordering vertical:',
  '- Service: `app/services/verticals/86596b62.js`',
  '- Route: `app/routes/verticals/86596b62.js`',
  '- Page: `app/public/verticals/86596b62.html` (served at `/cardinalhealth`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findOrderLine(lineCode) {
  return ORDER_LINES.find((line) => line.code === lineCode) || ORDER_LINES[0];
}

function findContract(contractCode) {
  return CONTRACT_TIERS[contractCode] || CONTRACT_TIERS['list-price'];
}

/**
 * Plan the shipment out of the distribution center and derive the delivery
 * date from the storage class's transit lead time.
 */
function buildDeliveryPlan(orderLine, requestedDeliveryIso) {
  const rules = HANDLING_RULES[orderLine.storageClass];

  const requested = new Date(requestedDeliveryIso);
  const estimated = new Date(requested.getTime() + rules.transitLeadTimeDays * 86400000);

  return {
    distributionCenter: 'DC 0428 \u2014 Groveport, OH',
    handling: rules.label,
    requestedDeliveryAt: requested.toISOString(),
    estimatedDeliveryAt: estimated.toISOString(),
    transitLeadTimeDays: rules.transitLeadTimeDays,
    requiresSignature: rules.requiresSignature,
    dockInstruction: rules.dockInstruction,
  };
}

/**
 * Order total billed to the account, after the contract's surcharge waiver.
 */
function buildChargeEstimate(orderLine, contractCode) {
  const rules = HANDLING_RULES[orderLine.storageClass];
  const contract = findContract(contractCode);
  const surchargeUsd = Number(
    (rules.packagingSurchargeUsd * (1 - contract.surchargeWaivedPct / 100)).toFixed(2),
  );

  return {
    contract: contract.label,
    extendedPriceUsd: orderLine.extendedPriceUsd,
    packagingSurchargeUsd: surchargeUsd,
    surchargeWaivedPct: contract.surchargeWaivedPct,
    orderTotalUsd: Number((orderLine.extendedPriceUsd + surchargeUsd).toFixed(2)),
  };
}

/**
 * Assemble the confirmation shown to the buyer.
 */
function buildOrderResult(orderNumber, orderLine, shipTo, delivery, charges) {
  return {
    orderNumber,
    status: 'submitted',
    line: {
      code: orderLine.code,
      name: orderLine.name,
      identifier: orderLine.identifier,
      quantity: orderLine.quantity,
      unitOfMeasure: orderLine.unitOfMeasure,
    },
    shipTo,
    delivery,
    charges,
    asnEmailQueued: true,
  };
}

/**
 * Submits a Cardinal Health Market order and returns the confirmation.
 */
async function submitOrder(data) {
  const startTime = Date.now();
  const orderNumber = `CH-${uuidv4().slice(0, 8).toUpperCase()}`;

  const accountNumber = String(data.accountNumber || '').trim();
  const purchaseOrder = String(data.purchaseOrder || '').trim();
  const requestedDelivery = String(data.requestedDelivery || '').trim();
  const parsedDelivery = new Date(requestedDelivery);

  if (!accountNumber || !purchaseOrder || !requestedDelivery || Number.isNaN(parsedDelivery.getTime())) {
    const validationError = new Error('Enter your account number, purchase order and a valid requested delivery date.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_ORDER_REQUEST';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Submitting Cardinal Health Market order', {
    orderNumber,
    orderLine: data.orderLine,
    contract: data.contract,
    service: 'customer-86596b62-distribution-ordering',
    route: '/api/86596b62/submit-order',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const orderLine = findOrderLine(data.orderLine);
    const delivery = buildDeliveryPlan(orderLine, requestedDelivery);
    const charges = buildChargeEstimate(orderLine, data.contract);
    const result = buildOrderResult(orderNumber, orderLine, {
      name: data.shipToName || 'Mercy Regional Medical Center \u2014 Central Supply',
      accountNumber,
      purchaseOrder,
    }, delivery, charges);

    const duration = Date.now() - startTime;

    incrementMetric('distribution_ordering.order_success', {
      route: '/api/86596b62/submit-order',
      orderLine: orderLine.code,
      contract: data.contract || 'list-price',
    });
    recordTiming('distribution_ordering.order_latency', duration, {
      route: '/api/86596b62/submit-order',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('distribution_ordering.order_failure', {
      route: '/api/86596b62/submit-order',
      errorClass: error.name,
      orderLine: data.orderLine,
    });
    recordTiming('distribution_ordering.order_latency', duration, {
      route: '/api/86596b62/submit-order',
      error: 'true',
    });

    logger.error('Order submission failed', {
      orderNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      orderLine: data.orderLine,
      contract: data.contract,
      service: 'customer-86596b62-distribution-ordering',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/86596b62/submit-order',
        service: 'customer-86596b62-distribution-ordering',
        orderLine: data.orderLine,
      },
      extra: {
        orderNumber,
        contract: data.contract,
        requestedDelivery: data.requestedDelivery,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/86596b62.js \u2014 buildDeliveryPlan',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-86596b62-distribution-ordering',
      verticalLabel: 'Distribution Ordering',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '86596b62',
      slackMemberId: 'U0BKV8PTK6F',
      tags: [
        { key: 'route', value: '/api/86596b62/submit-order' },
        { key: 'service', value: 'customer-86596b62-distribution-ordering' },
        { key: 'orderLine', value: data.orderLine },
        { key: 'contract', value: data.contract },
      ],
      extra: {
        orderNumber,
        contract: data.contract,
        requestedDelivery: data.requestedDelivery,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-86596b62-distribution-ordering@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for order submission error', {
        error: err.message,
        orderNumber,
      });
    });

    throw error;
  }
}

module.exports = {
  submitOrder,
  REMEDIATION_DIRECTIVE,
  ORDER_LINES,
  HANDLING_RULES,
  CONTRACT_TIERS,
};
