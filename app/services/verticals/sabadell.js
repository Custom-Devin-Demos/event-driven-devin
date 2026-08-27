const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ACCOUNT_PRODUCTS = {
  'cuenta-online': {
    label: 'Sabadell Online Account',
    remunerationProgram: 'cuenta_online_2026',
    maxFirstYearEur: 2580,
  },
  'cuenta-expansion': {
    label: 'Sabadell Expansión Account',
    remunerationProgram: 'expansion_standard',
    maxFirstYearEur: 1200,
  },
  'cuenta-ahorro': {
    label: 'Sabadell Savings Account',
    remunerationProgram: 'ahorro_flex',
    maxFirstYearEur: 400,
  },
};

const REMUNERATION_PROGRAMS = {
  expansion_standard: {
    label: 'Expansión standard remuneration',
    grossRatePct: 1.5,
    payrollBonusEur: 300,
    settlementCadence: 'Annual',
  },
  ahorro_flex: {
    label: 'Ahorro flex remuneration',
    grossRatePct: 1.25,
    payrollBonusEur: 0,
    settlementCadence: 'Monthly',
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Banco Sabadell online account opening vertical:',
  '- Service: `app/services/verticals/sabadell.js`',
  '- Route: `app/routes/verticals/sabadell.js`',
  '- Page: `app/public/verticals/sabadell.html` (served at `/sabadell`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function resolveRemunerationProgram(code) {
  return REMUNERATION_PROGRAMS[code];
}

function computeFirstYearReturn(product, monthlyIncomeEur, payrollDirectDeposit) {
  const program = resolveRemunerationProgram(product.remunerationProgram);
  const grossInterestEur = (monthlyIncomeEur * 12 * program.grossRatePct) / 100;
  const payrollBonusEur = payrollDirectDeposit ? program.payrollBonusEur : 0;

  return {
    grossInterestEur: Number(grossInterestEur.toFixed(2)),
    payrollBonusEur,
    firstYearReturnEur: Number((grossInterestEur + payrollBonusEur).toFixed(2)),
  };
}

function createIban() {
  return `ES91 2100 0418 4502 ${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`;
}

async function openAccount(data) {
  const startTime = Date.now();
  const contractNumber = `SAB-${uuidv4().slice(0, 8).toUpperCase()}`;
  const applicantName = String(data.applicantName || '').trim();
  const documentId = String(data.documentId || '').trim();

  if (!applicantName || !/^[0-9XYZ][0-9]{7}[A-Z]$/.test(documentId)) {
    const validationError = new Error('Enter your full name and a valid DNI/NIE.');
    validationError.name = 'ValidationError';
    validationError.code = 'VALIDATION_ERROR';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Opening Banco Sabadell account', {
    contractNumber,
    product: data.product,
    service: 'customer-sabadell-account-opening',
    route: '/api/sabadell/open-account',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const product = ACCOUNT_PRODUCTS[data.product] || ACCOUNT_PRODUCTS['cuenta-online'];
    const monthlyIncomeEur = Number(data.monthlyIncomeEur) || 0;
    const payrollDirectDeposit = Boolean(data.payrollDirectDeposit);
    const returnDetails = computeFirstYearReturn(product, monthlyIncomeEur, payrollDirectDeposit);
    const program = resolveRemunerationProgram(product.remunerationProgram);
    const firstYearReturnEur = Number(
      Math.min(returnDetails.firstYearReturnEur, product.maxFirstYearEur).toFixed(2),
    );
    const duration = Date.now() - startTime;

    incrementMetric('sabadell.account_opening.success', {
      route: '/api/sabadell/open-account',
      product: data.product || 'cuenta-online',
    });
    recordTiming('sabadell.account_opening.latency', duration, {
      route: '/api/sabadell/open-account',
    });

    return {
      success: true,
      contractNumber,
      iban: createIban(),
      applicantName,
      product: {
        code: data.product || 'cuenta-online',
        label: product.label,
      },
      remunerationProgram: program.label,
      grossRatePct: program.grossRatePct,
      grossInterestEur: returnDetails.grossInterestEur,
      payrollBonusEur: returnDetails.payrollBonusEur,
      firstYearReturnEur,
      settlementCadence: program.settlementCadence,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    Sentry.captureException(error, {
      tags: {
        route: '/api/sabadell/open-account',
        service: 'customer-sabadell-account-opening',
        product: data.product,
      },
      extra: {
        contractNumber,
        applicantName,
        documentIdProvided: Boolean(data.documentId),
      },
    });
    incrementMetric('sabadell.account_opening.failure', {
      route: '/api/sabadell/open-account',
      errorClass: error.name,
      product: data.product,
    });
    recordTiming('sabadell.account_opening.latency', duration, {
      route: '/api/sabadell/open-account',
      error: 'true',
    });
    logger.error('Banco Sabadell account opening failed', {
      contractNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      product: data.product,
      service: 'customer-sabadell-account-opening',
    });

    await createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/sabadell.js — computeFirstYearReturn',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-sabadell-account-opening',
      verticalLabel: 'Banco Sabadell Online Account',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'sabadell',
      tags: [
        { key: 'route', value: '/api/sabadell/open-account' },
        { key: 'service', value: 'customer-sabadell-account-opening' },
        { key: 'product', value: data.product || 'cuenta-online' },
      ],
      extra: {
        contractNumber,
        applicantName,
        documentIdProvided: Boolean(data.documentId),
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-sabadell-account-opening@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    });

    throw error;
  }
}

module.exports = {
  ACCOUNT_PRODUCTS,
  REMUNERATION_PROGRAMS,
  REMEDIATION_DIRECTIVE,
  resolveRemunerationProgram,
  computeFirstYearReturn,
  openAccount,
};
