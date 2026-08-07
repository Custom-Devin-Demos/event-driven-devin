const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Deposit products available through the online application flow.
 */
const PRODUCTS = [
  {
    code: 'ADV-STUDENT-CHQ',
    name: 'RBC Advantage Banking account for students',
    type: 'chequing',
    monthlyFee: 0,
    debitTransactions: 'unlimited',
    minimumAge: 13,
  },
  {
    code: 'HI-ESAVINGS',
    name: 'RBC High Interest eSavings account',
    type: 'savings',
    monthlyFee: 0,
    promotionalRate: 0.046,
    minimumAge: 13,
  },
  {
    code: 'SNL-CHQ',
    name: 'RBC Signature No Limit Banking',
    type: 'chequing',
    monthlyFee: 16.95,
    debitTransactions: 'unlimited',
    minimumAge: 18,
  },
];

/**
 * Applicant segments recognised by the account-opening service. Each segment
 * carries the fee waivers and document requirements applied to the application.
 */
const APPLICANT_SEGMENTS = {
  'student-full-time': {
    label: 'Full-time student',
    feeWaiver: true,
    proofOfEnrolment: true,
    maxAgeForWaiver: 24,
  },
  'student-part-time': {
    label: 'Part-time student',
    feeWaiver: true,
    proofOfEnrolment: true,
    maxAgeForWaiver: 24,
  },
  newcomer: {
    label: 'Newcomer to Canada',
    feeWaiver: true,
    proofOfEnrolment: false,
    maxAgeForWaiver: null,
  },
  standard: {
    label: 'Standard applicant',
    feeWaiver: false,
    proofOfEnrolment: false,
    maxAgeForWaiver: null,
  },
};

/**
 * Active acquisition campaigns keyed by promo code.
 *
 * The student AirPods campaign was migrated to the campaign platform and its
 * reward details now live under `rewards` rather than at the top level.
 */
const CAMPAIGNS = {
  'STUDENT-AIRPODS-2026': {
    label: 'Students Get AirPods 4',
    eligibleProducts: ['ADV-STUDENT-CHQ'],
    endsOn: '2026-11-02',
    qualifyBy: '2027-01-15',
    rewards: {
      hardware: { sku: 'APPLE-AIRPODS-4', description: 'AirPods 4' },
      subscription: { sku: 'APPLE-MUSIC-3M', months: 3 },
    },
  },
  'ESAVINGS-460-2026': {
    label: 'Get 4.60% Interest',
    eligibleProducts: ['HI-ESAVINGS'],
    endsOn: '2026-11-02',
    qualifyBy: '2027-01-15',
    promotion: {
      rate: 0.046,
      termMonths: 3,
    },
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
  'The failing code path is the RBC online account-opening vertical:',
  '- Service: `app/services/verticals/3cec99d4.js`',
  '- Route: `app/routes/verticals/3cec99d4.js`',
  '- Page: `app/public/verticals/3cec99d4.html` (served at `/rbc`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Provincial requirements that gate the online application.
 */
const PROVINCE_RULES = {
  ON: { minimumAge: 13, requiresBranchVisit: false },
  QC: { minimumAge: 14, requiresBranchVisit: false },
  BC: { minimumAge: 13, requiresBranchVisit: false },
  AB: { minimumAge: 13, requiresBranchVisit: false },
};

function findProduct(productCode) {
  return PRODUCTS.find((product) => product.code === productCode) || PRODUCTS[0];
}

/**
 * Resolve the campaign attached to an application, falling back to the first
 * campaign that lists the product as eligible.
 */
function resolveCampaign(promoCode, productCode) {
  if (promoCode && CAMPAIGNS[promoCode]) return CAMPAIGNS[promoCode];
  return Object.values(CAMPAIGNS).find((campaign) => campaign.eligibleProducts.includes(productCode)) || null;
}

/**
 * Build the eligibility decision for the applicant and selected product.
 */
function evaluateEligibility(product, applicantType, province) {
  const segment = APPLICANT_SEGMENTS[applicantType] || APPLICANT_SEGMENTS.standard;
  const provinceRule = PROVINCE_RULES[province] || PROVINCE_RULES.ON;
  const minimumAge = Math.max(product.minimumAge, provinceRule.minimumAge);

  return {
    segment: segment.label,
    feeWaiver: segment.feeWaiver,
    proofOfEnrolmentRequired: segment.proofOfEnrolment,
    minimumAge,
    requiresBranchVisit: provinceRule.requiresBranchVisit,
    documentsRequired: segment.proofOfEnrolment
      ? ['Government-issued photo ID', 'Proof of enrolment']
      : ['Government-issued photo ID'],
  };
}

/**
 * Attach the campaign reward to the application so it can be displayed on the
 * confirmation screen and fulfilled once the account is funded.
 */
function buildOfferSummary(campaign, product) {
  return {
    campaign: campaign.label,
    product: product.name,
    hardwareSku: campaign.promotion.airpodsSku,
    bonusMonths: campaign.promotion.bonusMonths,
    endsOn: campaign.endsOn,
    qualifyBy: campaign.qualifyBy,
  };
}

/**
 * Assemble the application package returned to the applicant.
 */
function buildApplicationPackage(applicationId, product, eligibility, offerSummary) {
  return {
    applicationId,
    status: 'started',
    product: {
      code: product.code,
      name: product.name,
      type: product.type,
      monthlyFee: eligibility.feeWaiver ? 0 : product.monthlyFee,
    },
    eligibility,
    offer: offerSummary,
    nextStep: 'verify-identity',
    estimatedMinutes: 8,
  };
}

/**
 * Starts an online deposit-account application.
 */
async function openAccount(data) {
  const startTime = Date.now();
  const applicationId = uuidv4();

  logger.info('Starting online account application', {
    applicationId,
    productCode: data.productCode,
    applicantType: data.applicantType,
    promoCode: data.promoCode,
    province: data.province,
    service: 'customer-3cec99d4-account-opening',
    route: '/api/3cec99d4/open-account',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const product = findProduct(data.productCode);
    const campaign = resolveCampaign(data.promoCode, product.code);
    const eligibility = evaluateEligibility(product, data.applicantType, data.province);
    const offerSummary = campaign ? buildOfferSummary(campaign, product) : null;
    const application = buildApplicationPackage(applicationId, product, eligibility, offerSummary);

    application.startedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('account_application.success', {
      route: '/api/3cec99d4/open-account',
      product: product.code,
    });
    recordTiming('account_application.latency', duration, {
      route: '/api/3cec99d4/open-account',
    });

    return application;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('account_application.failure', {
      route: '/api/3cec99d4/open-account',
      errorClass: error.name,
      product: data.productCode,
    });
    recordTiming('account_application.latency', duration, {
      route: '/api/3cec99d4/open-account',
      error: 'true',
    });

    logger.error('Online account application failed', {
      applicationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      productCode: data.productCode,
      applicantType: data.applicantType,
      promoCode: data.promoCode,
      service: 'customer-3cec99d4-account-opening',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/3cec99d4/open-account',
        service: 'customer-3cec99d4-account-opening',
        product: data.productCode,
      },
      extra: {
        applicationId,
        applicantType: data.applicantType,
        promoCode: data.promoCode,
        province: data.province,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/3cec99d4.js \u2014 buildOfferSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-3cec99d4-account-opening',
      verticalLabel: 'Online Account Opening',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '3cec99d4',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/3cec99d4/open-account' },
        { key: 'service', value: 'customer-3cec99d4-account-opening' },
        { key: 'product', value: data.productCode },
        { key: 'promo', value: data.promoCode },
      ],
      extra: {
        applicationId,
        applicantType: data.applicantType,
        promoCode: data.promoCode,
        province: data.province,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-3cec99d4-account-opening@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for account application error', {
        error: err.message,
        applicationId,
      });
    });

    throw error;
  }
}

module.exports = {
  openAccount,
  REMEDIATION_DIRECTIVE,
  PRODUCTS,
  CAMPAIGNS,
  APPLICANT_SEGMENTS,
  PROVINCE_RULES,
};
