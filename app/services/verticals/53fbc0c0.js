const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Product lines offered on the "Any questions about our products?" contact
 * form. Each line routes the inquiry to a product division for triage.
 */
const PRODUCT_LINES = [
  { code: 'combines', label: 'Combines', division: 'GRAIN-HARVEST' },
  { code: 'forage-harvesters', label: 'Forage Harvesters', division: 'FORAGE' },
  { code: 'tractors', label: 'Tractors', division: 'TRACTORS' },
  { code: 'balers-hay', label: 'Balers & Hay Tools', division: 'GREENLINE' },
  { code: 'smart-farming', label: 'CLAAS connect & Smart Farming', division: 'DIGITAL' },
];

/**
 * Product division directory used to attach a dealer-network owner and a
 * response SLA to every routed inquiry.
 *
 * NOTE: GRAIN-HARVEST was renamed from COMBINE-HARVEST during the MY26
 * product-line refresh; the directory entry was migrated under the old key.
 */
const DIVISION_DIRECTORY = {
  'COMBINE-HARVEST': {
    name: 'Combine Harvesting',
    intakeQueue: 'combines-intake',
    slaHours: 24,
    escalation: 'harvesting-product-director',
  },
  FORAGE: {
    name: 'Forage Harvesting',
    intakeQueue: 'forage-intake',
    slaHours: 24,
    escalation: 'forage-product-director',
  },
  TRACTORS: {
    name: 'Tractors',
    intakeQueue: 'tractors-intake',
    slaHours: 48,
    escalation: 'tractor-product-director',
  },
  GREENLINE: {
    name: 'Balers & Hay Tools',
    intakeQueue: 'greenline-intake',
    slaHours: 48,
    escalation: 'greenline-product-director',
  },
  DIGITAL: {
    name: 'CLAAS connect & Smart Farming',
    intakeQueue: 'digital-intake',
    slaHours: 72,
    escalation: 'digital-solutions-lead',
  },
};

/**
 * Dealer-network stats surfaced on the site.
 */
const NETWORK_STATS = [
  { code: 'dealers', label: 'North American Dealers', value: '250+' },
  { code: 'countries', label: 'Countries Served', value: '140' },
  { code: 'employees', label: 'Employees Worldwide', value: '12,000+' },
  { code: 'years', label: 'Years of Harvest Innovation', value: '110+' },
];

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the CLAAS product-inquiry vertical:',
  '- Service: `app/services/verticals/53fbc0c0.js`',
  '- Route: `app/routes/verticals/53fbc0c0.js`',
  '- Page: `app/public/verticals/53fbc0c0.html` (served at `/claas`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findProductLine(lineCode) {
  return PRODUCT_LINES.find((line) => line.code === lineCode) || PRODUCT_LINES[0];
}

/**
 * Resolve the division directory entry that owns a product line.
 */
function resolveDivision(line) {
  return DIVISION_DIRECTORY[line.division];
}

/**
 * Build the routing envelope attached to an accepted inquiry: the owning
 * division, the queue it lands in, and the response commitment shown to
 * the sender.
 */
function buildRoutingEnvelope(line, division) {
  return {
    productLine: line.label,
    division: division.name,
    intakeQueue: division.intakeQueue,
    responseCommitmentHours: division.slaHours,
    escalationPath: division.escalation,
  };
}

/**
 * Assemble the confirmation returned to the sender.
 */
function buildConfirmation(inquiryId, routing) {
  return {
    inquiryId,
    status: 'received',
    routing,
    nextStep: 'A ' + routing.division + ' specialist from your regional dealer network will respond within '
      + routing.responseCommitmentHours + ' hours.',
  };
}

/**
 * Submit a product inquiry from the "Any questions about our products?" form.
 */
async function submitInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Submitting product inquiry', {
    inquiryId,
    productLine: data.productLine,
    farmName: data.farmName,
    service: 'customer-53fbc0c0-product-inquiry',
    route: '/api/53fbc0c0/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const line = findProductLine(data.productLine);
    const division = resolveDivision(line);
    const routing = buildRoutingEnvelope(line, division);
    const confirmation = buildConfirmation(inquiryId, routing);

    incrementMetric('product_inquiry.received', {
      route: '/api/53fbc0c0/inquiry',
      productLine: line.code,
    });
    recordTiming('product_inquiry.latency', Date.now() - startTime, {
      route: '/api/53fbc0c0/inquiry',
      error: 'false',
    });

    logger.info('Product inquiry routed', {
      inquiryId,
      division: routing.division,
      intakeQueue: routing.intakeQueue,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('product_inquiry.failure', {
      route: '/api/53fbc0c0/inquiry',
      errorClass: error.name,
      productLine: data.productLine || 'unknown',
    });
    recordTiming('product_inquiry.latency', duration, {
      route: '/api/53fbc0c0/inquiry',
      error: 'true',
    });

    logger.error('Product inquiry failed', {
      inquiryId,
      productLine: data.productLine,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-53fbc0c0-product-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-53fbc0c0-product-inquiry',
        route: '/api/53fbc0c0/inquiry',
        productLine: data.productLine || 'unknown',
      },
      extra: {
        inquiryId,
        productLine: data.productLine,
        farmName: data.farmName,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/53fbc0c0.js \u2014 buildRoutingEnvelope',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-53fbc0c0-product-inquiry',
      verticalLabel: 'Product Inquiry Routing',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'default',
      tags: [
        { key: 'route', value: '/api/53fbc0c0/inquiry' },
        { key: 'service', value: 'customer-53fbc0c0-product-inquiry' },
        { key: 'productLine', value: data.productLine || 'unknown' },
      ],
      extra: {
        inquiryId,
        productLine: data.productLine,
        farmName: data.farmName,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for product inquiry error', {
        inquiryId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitInquiry,
  PRODUCT_LINES,
  NETWORK_STATS,
};
