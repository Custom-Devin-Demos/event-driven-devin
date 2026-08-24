const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Vendors enrolled in business bill pay, as shown on the Pay bills page.
 */
const VENDORS = [
  {
    id: 'abc-print',
    name: 'ABC Print',
    group: 'Marketing',
    lastPaid: 'Jun 12, 2025',
    unpaidBills: 1,
    totalAmount: 324.5,
    accountLast4: '4417',
  },
  {
    id: 'deja-hardware',
    name: 'Deja Hardware Supplies',
    group: 'Facilities',
    lastPaid: 'Jun 09, 2025',
    unpaidBills: 2,
    totalAmount: 1233.0,
    accountLast4: '8820',
  },
  {
    id: 'swifthost-web',
    name: 'SwiftHost Web Services',
    group: 'Technology',
    lastPaid: 'May 30, 2025',
    unpaidBills: 1,
    totalAmount: 2876.0,
    accountLast4: '5591',
  },
  {
    id: 'universal-logistics',
    name: 'Universal Logistics LLC',
    group: 'Logistics',
    lastPaid: 'Jun 02, 2025',
    unpaidBills: 1,
    totalAmount: 918.75,
    accountLast4: '2043',
  },
  {
    id: 'yellow-print-house',
    name: 'Yellow Print House LLC',
    group: 'Marketing',
    lastPaid: 'Apr 28, 2025',
    unpaidBills: 1,
    totalAmount: 460.0,
    accountLast4: '7712',
  },
  {
    id: 'anderson-properties',
    name: 'Anderson Properties',
    group: 'Facilities',
    lastPaid: 'Jun 01, 2025',
    unpaidBills: 0,
    totalAmount: 0,
    accountLast4: '3308',
  },
  {
    id: 'american-electric-power',
    name: 'American Electric Power',
    group: 'Utilities',
    lastPaid: 'Jun 05, 2025',
    unpaidBills: 0,
    totalAmount: 0,
    accountLast4: '9164',
  },
];

/**
 * Funding account the bill pay page debits.
 */
const FUNDING_ACCOUNT = {
  id: 'usb-business-checking-6612',
  label: 'Platinum Business Checking',
  last4: '6612',
  availableBalance: 148920.44,
};

/**
 * ACH remittance formats keyed by the settlement rail a payment lands on.
 *
 * NOTE: the same-day ACH rail (`ach-same-day`) was enabled for high-value
 * business bill pay in the FY26 rails refresh; its remittance format was
 * expected to be registered alongside it.
 */
const REMITTANCE_FORMATS = {
  'ach-standard': {
    railName: 'ACH Standard',
    settlementDays: 3,
    addendaRecordLimit: 1,
    cutoffLocal: '20:00 CT',
  },
  'ach-next-day': {
    railName: 'ACH Next Day',
    settlementDays: 1,
    addendaRecordLimit: 4,
    cutoffLocal: '16:30 CT',
  },
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
  'The failing code path is the U.S. Bank business bill pay vertical:',
  '- Service: `app/services/verticals/4f9ede2a.js`',
  '- Route: `app/routes/verticals/4f9ede2a.js`',
  '- Page: `app/public/verticals/4f9ede2a.html` (served at `/usbank`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findVendor(vendorId) {
  return VENDORS.find((vendor) => vendor.id === vendorId);
}

/**
 * Resolve the settlement rail a bill payment routes over. Payments at or above
 * the high-value threshold are pushed onto same-day ACH so vendors are funded
 * before their cutoff.
 */
function resolveSettlementRail(amountUsd) {
  if (amountUsd < 1000) return 'ach-standard';
  if (amountUsd < 2500) return 'ach-next-day';
  return 'ach-same-day';
}

/**
 * Build the remittance advice attached to a payment: the rail it settles on,
 * the addenda budget for vendor invoice references, and the posting date shown
 * back to the payer.
 */
function buildRemittanceAdvice(vendor, amountUsd) {
  const rail = resolveSettlementRail(amountUsd);
  const format = REMITTANCE_FORMATS[rail];

  return {
    rail,
    railName: format.railName,
    settlementDays: format.settlementDays,
    addendaRecordLimit: format.addendaRecordLimit,
    cutoffLocal: format.cutoffLocal,
    invoiceReferences: Array.from(
      { length: Math.min(vendor.unpaidBills, format.addendaRecordLimit) },
      (_v, index) => `INV-${vendor.accountLast4}-${index + 1}`,
    ),
  };
}

/**
 * Assemble the payment confirmation shown in the Pay bills activity toast.
 */
function buildConfirmation(paymentId, vendor, amountUsd, remittance) {
  return {
    paymentId,
    status: 'scheduled',
    vendor: vendor.name,
    amount: amountUsd,
    fundingAccount: `${FUNDING_ACCOUNT.label} \u2014 ****${FUNDING_ACCOUNT.last4}`,
    remittance,
  };
}

/**
 * Pay a vendor's outstanding bills from the business checking account.
 */
async function payVendor(data) {
  const startTime = Date.now();
  const paymentId = uuidv4();
  const vendor = findVendor(data.vendorId);

  logger.info('Paying vendor bills', {
    paymentId,
    vendorId: data.vendorId,
    service: 'customer-4f9ede2a-bill-pay',
    route: '/api/4f9ede2a/pay',
  });

  if (!vendor) {
    const error = new Error(`Unknown vendor: ${data.vendorId || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'VENDOR_NOT_ENROLLED';
    throw error;
  }

  if (!vendor.unpaidBills || vendor.totalAmount <= 0) {
    const error = new Error(`${vendor.name} has no unpaid bills to pay`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'NO_UNPAID_BILLS';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const amountUsd = vendor.totalAmount;
    const remittance = buildRemittanceAdvice(vendor, amountUsd);
    const confirmation = buildConfirmation(paymentId, vendor, amountUsd, remittance);

    incrementMetric('bill_pay.scheduled', {
      route: '/api/4f9ede2a/pay',
      rail: remittance.rail,
    });
    recordTiming('bill_pay.latency', Date.now() - startTime, {
      route: '/api/4f9ede2a/pay',
      error: 'false',
    });

    logger.info('Vendor payment scheduled', {
      paymentId,
      vendor: vendor.name,
      rail: remittance.rail,
      amount: amountUsd,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('bill_pay.failure', {
      route: '/api/4f9ede2a/pay',
      errorClass: error.name,
      vendorId: vendor.id,
    });
    recordTiming('bill_pay.latency', duration, {
      route: '/api/4f9ede2a/pay',
      error: 'true',
    });

    logger.error('Vendor payment failed', {
      paymentId,
      vendor: vendor.name,
      amount: vendor.totalAmount,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-4f9ede2a-bill-pay',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-4f9ede2a-bill-pay',
        route: '/api/4f9ede2a/pay',
        vendorId: vendor.id,
      },
      extra: {
        paymentId,
        vendor: vendor.name,
        amount: vendor.totalAmount,
        unpaidBills: vendor.unpaidBills,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4f9ede2a.js \u2014 buildRemittanceAdvice',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U0BQZBHCNMA',
      service: 'customer-4f9ede2a-bill-pay',
      verticalLabel: 'Business Bill Pay',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '4f9ede2a',
      tags: [
        { key: 'route', value: '/api/4f9ede2a/pay' },
        { key: 'service', value: 'customer-4f9ede2a-bill-pay' },
        { key: 'vendor', value: vendor.id },
      ],
      extra: {
        paymentId,
        vendor: vendor.name,
        amount: vendor.totalAmount,
        unpaidBills: vendor.unpaidBills,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for bill pay error', {
        paymentId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  payVendor,
  VENDORS,
  FUNDING_ACCOUNT,
};
