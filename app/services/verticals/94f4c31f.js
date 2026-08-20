const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Brokerage products available through the online application flow.
 */
const PRODUCTS = [
  {
    code: 'SELF-INVEST',
    name: 'Citi Self Invest',
    type: 'self-directed-brokerage',
    commissionPerTrade: 0,
    accountMinimum: 0,
    minimumAge: 18,
  },
  {
    code: 'WEALTH-BUILDER',
    name: 'Citi Wealth Builder',
    type: 'managed-portfolio',
    advisoryFeeRate: 0.0055,
    accountMinimum: 1000,
    minimumAge: 18,
  },
];

/**
 * Application steps in the order the applicant completes them.
 */
const APPLICATION_STEPS = [
  { id: 'personal-information', label: 'Personal Information' },
  { id: 'protect-your-account', label: 'Protect Your Account' },
  { id: 'profile-details', label: 'Profile Details' },
  { id: 'employment-and-income', label: 'Employment & Income' },
  { id: 'agreements-and-disclosures', label: 'Agreements & Disclosures' },
];

/**
 * SSA electronic-consent parameters applied to every verification request
 * submitted through Early Warning System LLC.
 */
const SSA_CONSENT_TERMS = {
  discloseTo: 'Citibank, N.A. and Citigroup Global Markets Inc.',
  intermediary: 'Early Warning System LLC',
  validDays: 90,
  singleUse: true,
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
  'The failing code path is the Citi Self Invest online application vertical:',
  '- Service: `app/services/verticals/94f4c31f.js`',
  '- Route: `app/routes/verticals/94f4c31f.js`',
  '- Page: `app/public/verticals/94f4c31f.html` (served at `/citi`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findProduct(productCode) {
  return PRODUCTS.find((product) => product.code === productCode) || PRODUCTS[0];
}

/**
 * Parse the date of birth captured on the Personal Information step.
 *
 * The application form labels the field MM/DD/YYYY, so the parser matches the
 * canonical zero-padded layout and hands the parts to the age and SSA-consent
 * builders.
 */
function parseDateOfBirth(dateOfBirth) {
  const match = String(dateOfBirth || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;

  return {
    month: Number(match[1]),
    day: Number(match[2]),
    year: Number(match[3]),
  };
}

/**
 * Derive the applicant's age from their parsed date of birth for the
 * product's minimum-age eligibility check.
 */
function deriveApplicantAge(parsedDob, asOf) {
  const birthDate = new Date(parsedDob.year, parsedDob.month - 1, parsedDob.day);
  let age = asOf.getFullYear() - birthDate.getFullYear();
  const hadBirthday = asOf.getMonth() > birthDate.getMonth()
    || (asOf.getMonth() === birthDate.getMonth() && asOf.getDate() >= birthDate.getDate());
  if (!hadBirthday) age -= 1;
  return age;
}

/**
 * Record the applicant's electronic signature consenting to SSA verification
 * of the name and date of birth submitted on this step.
 */
function buildSsaConsentRecord(firstName, lastName, parsedDob, consentedAt) {
  return {
    recorded: true,
    applicantName: `${firstName} ${lastName}`.trim(),
    dateOfBirth: `${parsedDob.year}-${String(parsedDob.month).padStart(2, '0')}-${String(parsedDob.day).padStart(2, '0')}`,
    discloseTo: SSA_CONSENT_TERMS.discloseTo,
    intermediary: SSA_CONSENT_TERMS.intermediary,
    validDays: SSA_CONSENT_TERMS.validDays,
    singleUse: SSA_CONSENT_TERMS.singleUse,
    consentedAt: consentedAt.toISOString(),
  };
}

/**
 * Assemble the step result returned to the applicant.
 */
function buildStepResult(applicationId, product, applicantAge, ssaConsent) {
  const nextStep = APPLICATION_STEPS[1];

  return {
    applicationId,
    status: 'in-progress',
    product: {
      code: product.code,
      name: product.name,
      type: product.type,
    },
    eligibility: {
      minimumAge: product.minimumAge,
      applicantAge,
      meetsMinimumAge: applicantAge >= product.minimumAge,
    },
    ssaConsent,
    completedStep: APPLICATION_STEPS[0].id,
    nextStep: nextStep.id,
    nextStepLabel: nextStep.label,
    estimatedMinutes: 10,
  };
}

/**
 * Processes the Personal Information step of an online brokerage application.
 */
async function submitPersonalInfo(data) {
  const startTime = Date.now();
  const applicationId = uuidv4();

  logger.info('Processing personal information step', {
    applicationId,
    productCode: data.productCode,
    dateOfBirthProvided: Boolean(data.dateOfBirth),
    service: 'customer-94f4c31f-account-application',
    route: '/api/94f4c31f/personal-info',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const product = findProduct(data.productCode);
    const now = new Date();

    const parsedDob = parseDateOfBirth(data.dateOfBirth);
    const applicantAge = deriveApplicantAge(parsedDob, now);
    const ssaConsent = buildSsaConsentRecord(data.firstName, data.lastName, parsedDob, now);

    const result = buildStepResult(applicationId, product, applicantAge, ssaConsent);

    result.startedAt = now.toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('brokerage_application.step_success', {
      route: '/api/94f4c31f/personal-info',
      product: product.code,
      step: 'personal-information',
    });
    recordTiming('brokerage_application.step_latency', duration, {
      route: '/api/94f4c31f/personal-info',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('brokerage_application.step_failure', {
      route: '/api/94f4c31f/personal-info',
      errorClass: error.name,
      product: data.productCode,
    });
    recordTiming('brokerage_application.step_latency', duration, {
      route: '/api/94f4c31f/personal-info',
      error: 'true',
    });

    logger.error('Personal information step failed', {
      applicationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      productCode: data.productCode,
      dateOfBirthProvided: Boolean(data.dateOfBirth),
      service: 'customer-94f4c31f-account-application',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/94f4c31f/personal-info',
        service: 'customer-94f4c31f-account-application',
        product: data.productCode,
      },
      extra: {
        applicationId,
        step: 'personal-information',
        dateOfBirthProvided: Boolean(data.dateOfBirth),
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/94f4c31f.js \u2014 deriveApplicantAge',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-94f4c31f-account-application',
      verticalLabel: 'Online Brokerage Application',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '94f4c31f',
      slackMemberId: 'U0BKV8PTK6F',
      tags: [
        { key: 'route', value: '/api/94f4c31f/personal-info' },
        { key: 'service', value: 'customer-94f4c31f-account-application' },
        { key: 'product', value: data.productCode },
        { key: 'step', value: 'personal-information' },
      ],
      extra: {
        applicationId,
        step: 'personal-information',
        dateOfBirthProvided: Boolean(data.dateOfBirth),
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-94f4c31f-account-application@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for brokerage application error', {
        error: err.message,
        applicationId,
      });
    });

    throw error;
  }
}

module.exports = {
  submitPersonalInfo,
  REMEDIATION_DIRECTIVE,
  PRODUCTS,
  APPLICATION_STEPS,
  SSA_CONSENT_TERMS,
};
