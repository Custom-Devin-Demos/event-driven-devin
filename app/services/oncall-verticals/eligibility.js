const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/eligibility/check';
const SERVICE = 'together-website-eligibility';

const EMPLOYMENT_TYPES = ['employed', 'self-employed', 'retired'];
const MAX_LTV = 0.75;
const INCOME_MULTIPLE = 4.5;
const MIN_LOAN = 10000;
const MAX_LOAN = 1000000;
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

function validationError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = 400;
  return err;
}

/**
 * Strip currency formatting typed into the website form ("£45,000", "45 000").
 */
function sanitiseCurrency(raw) {
  return String(raw == null ? '' : raw).replace(/[£,\s]/g, '');
}

function parseIncome(value) {
  const income = Number(value);
  if (!Number.isFinite(income) || income <= 0) {
    throw validationError('Please enter your annual income as a number, for example 45000.', 'INVALID_INCOME');
  }
  return Math.round(income);
}

/**
 * Self-employed income is the SA302 net-profit figure, which the accountant
 * export sends as plain digits.
 */
function parseSelfEmployedIncome(raw) {
  const figure = String(raw).trim().match(/^\d+(\.\d+)?$/);
  return parseIncome(figure[0]);
}

function normaliseIncome(raw, employmentType) {
  if (employmentType === 'self-employed') return parseSelfEmployedIncome(raw);
  return parseIncome(sanitiseCurrency(raw));
}

function parseAmount(raw, label, code) {
  const amount = Number(sanitiseCurrency(raw));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw validationError(`Please enter ${label} as a number.`, code);
  }
  return Math.round(amount);
}

function decide({ loanAmount, propertyValue, annualIncome }) {
  const ltv = loanAmount / propertyValue;
  const affordable = loanAmount <= annualIncome * INCOME_MULTIPLE;
  if (ltv > MAX_LTV) {
    return { decision: 'refer', headline: 'We\u2019d like to talk this through with you', reason: 'The amount you\u2019d like to borrow is more than 75% of your property\u2019s value, so one of our team will look at your options with you.' };
  }
  if (!affordable) {
    return { decision: 'refer', headline: 'We\u2019d like to talk this through with you', reason: 'Based on the income you entered, a specialist will review how much we could lend.' };
  }
  return { decision: 'eligible', headline: 'Good news \u2014 you look eligible', reason: 'Based on what you\u2019ve told us, you look eligible for a secured homeowner loan. This is not a formal offer and won\u2019t affect your credit score.' };
}

/**
 * Website "Check your eligibility" for a secured homeowner loan.
 */
async function checkEligibility(input, options = {}) {
  const startTime = Date.now();
  const enquiryId = `TMW-${uuidv4().slice(0, 8).toUpperCase()}`;
  const employmentType = String(input.employmentType || '').toLowerCase();

  logger.info('Website eligibility check', {
    enquiryId, employmentType, service: SERVICE, route: ROUTE,
  });

  try {
    if (!EMPLOYMENT_TYPES.includes(employmentType)) {
      throw validationError('Please choose your employment type.', 'INVALID_EMPLOYMENT_TYPE');
    }
    if (input.consent !== true) {
      throw validationError('Please confirm you\u2019re happy for us to use your details to check your eligibility.', 'CONSENT_REQUIRED');
    }
    const postcode = String(input.postcode || '').trim().toUpperCase();
    if (!UK_POSTCODE.test(postcode)) {
      throw validationError('Please enter a valid UK postcode.', 'INVALID_POSTCODE');
    }
    const loanAmount = parseAmount(input.loanAmount, 'the amount you\u2019d like to borrow', 'INVALID_LOAN_AMOUNT');
    const propertyValue = parseAmount(input.propertyValue, 'your property value', 'INVALID_PROPERTY_VALUE');
    if (loanAmount < MIN_LOAN || loanAmount > MAX_LOAN) {
      throw validationError('You can borrow between \u00a310,000 and \u00a31,000,000 online.', 'INVALID_LOAN_AMOUNT');
    }
    const annualIncome = normaliseIncome(input.annualIncome, employmentType);
    const outcome = decide({ loanAmount, propertyValue, annualIncome });
    const duration = Date.now() - startTime;

    incrementMetric('together_website.eligibility.success', { route: ROUTE, employment_type: employmentType, decision: outcome.decision });
    recordTiming('together_website.eligibility.latency', duration, { route: ROUTE, employment_type: employmentType });

    return {
      success: true,
      enquiryId,
      ...outcome,
      loanAmount,
      propertyValue,
      ltvPercent: Math.round((loanAmount / propertyValue) * 1000) / 10,
      employmentType,
      annualIncome,
      postcode,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const clientError = error.statusCode === 400;
    incrementMetric('together_website.eligibility.failure', { route: ROUTE, employment_type: employmentType || 'unknown', errorClass: error.name });
    recordTiming('together_website.eligibility.latency', duration, { route: ROUTE, employment_type: employmentType || 'unknown', error: 'true' });
    logger[clientError ? 'warn' : 'error']('Website eligibility check failed', {
      enquiryId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, employmentType, service: SERVICE,
    });
    if (!clientError) {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, employment_type: employmentType || 'unknown', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { enquiryId },
      });
    }
    throw error;
  }
}

module.exports = { checkEligibility, EMPLOYMENT_TYPES };
