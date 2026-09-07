const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Checking products offered on the account-opening page, mirroring the
 * citizensbank.com personal checking lineup.
 */
const CHECKING_PRODUCTS = [
  {
    id: 'one-deposit',
    name: 'One Deposit Checking',
    perksCode: 'odc_standard',
    monthlyFee: 9.99,
    feeWaiver: 'Waived with any deposit each statement period',
    minimumOpeningDeposit: 0,
  },
  {
    id: 'quest',
    name: 'Quest Checking with Citizens Paid Early\u2122',
    perksCode: 'quest_paid_early',
    monthlyFee: 25,
    feeWaiver: 'Waived with $5,000 in monthly direct deposits or $25,000 in combined balances',
    minimumOpeningDeposit: 50,
  },
  {
    id: 'student',
    name: 'Student Checking',
    perksCode: 'odc_student',
    monthlyFee: 0,
    feeWaiver: 'No monthly maintenance fee while enrolled',
    minimumOpeningDeposit: 0,
  },
];

/**
 * Welcome-package perks keyed by each product's perks program code.
 *
 * NOTE: the Quest relaunch mapped the flagship tier to the
 * `quest_paid_early` program code when Citizens Paid Early was bundled in;
 * its perks entry was expected to be registered alongside the rollout.
 */
const PERKS_PROGRAMS = {
  odc_standard: {
    programName: 'One Deposit Welcome',
    paidEarlyDays: 0,
    overdraftBuffer: 0,
    savingsRoundUps: true,
  },
  odc_student: {
    programName: 'Student Welcome',
    paidEarlyDays: 0,
    overdraftBuffer: 50,
    savingsRoundUps: true,
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
  'The failing code path is the Citizens Bank checking account opening vertical:',
  '- Service: `app/services/verticals/2ab0c5c9.js`',
  '- Route: `app/routes/verticals/2ab0c5c9.js`',
  '- Page: `app/public/verticals/2ab0c5c9.html` (served at `/citizens`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findProduct(productId) {
  return CHECKING_PRODUCTS.find((product) => product.id === productId);
}

/**
 * Assemble the welcome package for a newly opened account: the perks program
 * it enrolls in, when direct deposits become available, and the Round Ups
 * enrollment shown on the confirmation panel.
 */
function buildWelcomePackage(product, openingDeposit) {
  const perks = PERKS_PROGRAMS[product.perksCode];

  return {
    programName: perks.programName,
    paidEarlyDays: perks.paidEarlyDays,
    overdraftBuffer: perks.overdraftBuffer,
    savingsRoundUps: perks.savingsRoundUps,
    openingDeposit,
  };
}

/**
 * Assemble the confirmation shown in the account-opening panel.
 */
function buildConfirmation(applicationId, product, welcomePackage) {
  return {
    applicationId,
    status: 'approved',
    product: product.name,
    monthlyFee: product.monthlyFee,
    feeWaiver: product.feeWaiver,
    welcomePackage,
  };
}

/**
 * Open a checking account for an applicant.
 */
async function openAccount(data) {
  const startTime = Date.now();
  const applicationId = uuidv4();
  const product = findProduct(data.productId);

  logger.info('Opening checking account', {
    applicationId,
    productId: data.productId,
    service: 'customer-2ab0c5c9-account-opening',
    route: '/api/2ab0c5c9/open-account',
  });

  if (!product) {
    const error = new Error(`Unknown checking product: ${data.productId || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'PRODUCT_NOT_OFFERED';
    throw error;
  }

  const openingDeposit = Number(data.openingDeposit) || 0;
  if (openingDeposit < product.minimumOpeningDeposit) {
    const error = new Error(
      `${product.name} requires a minimum opening deposit of $${product.minimumOpeningDeposit}`,
    );
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'DEPOSIT_BELOW_MINIMUM';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const welcomePackage = buildWelcomePackage(product, openingDeposit);
    const confirmation = buildConfirmation(applicationId, product, welcomePackage);

    incrementMetric('account_opening.approved', {
      route: '/api/2ab0c5c9/open-account',
      product: product.id,
    });
    recordTiming('account_opening.latency', Date.now() - startTime, {
      route: '/api/2ab0c5c9/open-account',
      error: 'false',
    });

    logger.info('Checking account opened', {
      applicationId,
      product: product.name,
      openingDeposit,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('account_opening.failure', {
      route: '/api/2ab0c5c9/open-account',
      errorClass: error.name,
      product: product.id,
    });
    recordTiming('account_opening.latency', duration, {
      route: '/api/2ab0c5c9/open-account',
      error: 'true',
    });

    logger.error('Checking account opening failed', {
      applicationId,
      product: product.name,
      openingDeposit,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-2ab0c5c9-account-opening',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-2ab0c5c9-account-opening',
        route: '/api/2ab0c5c9/open-account',
        product: product.id,
      },
      extra: {
        applicationId,
        product: product.name,
        perksCode: product.perksCode,
        openingDeposit,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/2ab0c5c9.js \u2014 buildWelcomePackage',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-2ab0c5c9-account-opening',
      verticalLabel: 'Checking Account Opening',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '2ab0c5c9',
      tags: [
        { key: 'route', value: '/api/2ab0c5c9/open-account' },
        { key: 'service', value: 'customer-2ab0c5c9-account-opening' },
        { key: 'product', value: product.id },
      ],
      extra: {
        applicationId,
        product: product.name,
        perksCode: product.perksCode,
        openingDeposit,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for account opening error', {
        applicationId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  openAccount,
  CHECKING_PRODUCTS,
};
