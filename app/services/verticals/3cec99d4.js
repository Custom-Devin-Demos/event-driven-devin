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
 * Campaigns that award hardware or subscription rewards require the applicant
 * to be verified as a student before the reward is attached.
 */
const CAMPAIGNS = {
  'STUDENT-AIRPODS-2026': {
    label: 'Students Get AirPods 4',
    eligibleProducts: ['ADV-STUDENT-CHQ'],
    endsOn: '2026-11-02',
    qualifyBy: '2027-01-15',
    requiresStudentVerification: true,
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
    requiresStudentVerification: false,
    promotion: {
      rate: 0.046,
      termMonths: 3,
    },
  },
};

/**
 * Domain suffixes recognised as post-secondary institutions. Applicants whose
 * school email matches one are auto-verified; everyone else is routed to
 * in-branch verification with proof of enrolment.
 */
const ACADEMIC_DOMAIN_SUFFIXES = ['.edu', '.ac.ca', '.edu.ca', 'utoronto.ca', 'mcgill.ca', 'ubc.ca'];

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
 * Verify a student against the school email address supplied on the
 * application. Applicants on an academic domain are auto-verified; anyone
 * else completes verification in branch with proof of enrolment.
 */
function verifyStudentEmail(schoolEmail) {
  const domain = schoolEmail.split('@')[1].toLowerCase();
  const matched = ACADEMIC_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix));

  return {
    domain,
    autoVerified: matched,
    method: matched ? 'school-email' : 'in-branch',
  };
}

/**
 * Attach the campaign reward to the application so it can be displayed on the
 * confirmation screen and fulfilled once the account is funded.
 */
function buildOfferSummary(campaign, product, verification) {
  return {
    campaign: campaign.label,
    product: product.name,
    hardwareSku: campaign.rewards.hardware.sku,
    bonusMonths: campaign.rewards.subscription.months,
    endsOn: campaign.endsOn,
    qualifyBy: campaign.qualifyBy,
    studentVerification: verification,
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
    schoolEmailProvided: Boolean(data.schoolEmail),
    service: 'customer-3cec99d4-account-opening',
    route: '/api/3cec99d4/open-account',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const product = findProduct(data.productCode);
    const campaign = resolveCampaign(data.promoCode, product.code);
    const eligibility = evaluateEligibility(product, data.applicantType, data.province);

    let offerSummary = null;
    if (campaign && campaign.requiresStudentVerification) {
      const verification = verifyStudentEmail(data.schoolEmail);
      eligibility.proofOfEnrolmentRequired = !verification.autoVerified;
      eligibility.documentsRequired = verification.autoVerified
        ? ['Government-issued photo ID']
        : ['Government-issued photo ID', 'Proof of enrolment'];
      offerSummary = buildOfferSummary(campaign, product, verification);
    } else if (campaign) {
      offerSummary = {
        campaign: campaign.label,
        product: product.name,
        promotionalRate: campaign.promotion.rate,
        termMonths: campaign.promotion.termMonths,
        endsOn: campaign.endsOn,
        qualifyBy: campaign.qualifyBy,
      };
    }

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
      schoolEmailProvided: Boolean(data.schoolEmail),
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
        schoolEmailProvided: Boolean(data.schoolEmail),
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/3cec99d4.js \u2014 verifyStudentEmail',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-3cec99d4-account-opening',
      verticalLabel: 'Online Account Opening',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '3cec99d4',
      slackMemberId: 'U0BKV8PTK6F',
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
        schoolEmailProvided: Boolean(data.schoolEmail),
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
  ACADEMIC_DOMAIN_SUFFIXES,
};
