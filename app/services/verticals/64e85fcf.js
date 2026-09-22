const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/64e85fcf/quotes';
const SERVICE = 'svg-medsupp-quote-engine';
const SLACK_MEMBER_ID = process.env.SVG_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * States the SmartMatch agent desk is licensed to quote Medicare Supplement
 * plans in. Each state's filings are loaded for a single rating area, so a
 * ZIP must fall inside that area's prefixes to be quoted.
 */
const STATES = {
  MO: { name: 'Missouri', ratingArea: 'Kansas City metro', zipPrefixes: ['640', '641'], sampleZip: '64105' },
  KS: { name: 'Kansas', ratingArea: 'Johnson County', zipPrefixes: ['662'], sampleZip: '66210' },
  TX: { name: 'Texas', ratingArea: 'Dallas–Fort Worth', zipPrefixes: ['750', '751', '752', '753', '760', '761'], sampleZip: '75201' },
  FL: { name: 'Florida', ratingArea: 'Tampa Bay', zipPrefixes: ['335', '336', '337'], sampleZip: '33602' },
  AZ: { name: 'Arizona', ratingArea: 'Phoenix metro', zipPrefixes: ['850', '851', '852', '853'], sampleZip: '85004' },
};

const PLAN_F_ELIGIBILITY_CUTOFF = '2020-01-01';

/**
 * Standardized Medicare Supplement plans the desk quotes. Plan F is only
 * available to beneficiaries who were Medicare-eligible before 2020-01-01.
 */
const PLANS = {
  G: { label: 'Plan G', description: 'Covers everything except the Part B deductible', newlyEligible: true },
  N: { label: 'Plan N', description: 'Lower premium; copays for office and ER visits', newlyEligible: true },
  HDG: { label: 'High-Deductible Plan G', description: 'Plan G benefits after a $2,870 annual deductible', newlyEligible: true },
  F: { label: 'Plan F', description: 'First-dollar coverage — eligible before 2020 only', newlyEligible: false },
};

/**
 * Carriers appointed on the SmartMatch platform, with the states each is
 * appointed to write in.
 */
const CARRIERS = {
  'car-moo': { name: 'Mutual of Omaha', amBest: 'A+', states: ['MO', 'KS', 'TX', 'FL', 'AZ'], householdDiscountPct: 12, ratingMethod: 'attained_age', appointed: '2011' },
  'car-aet': { name: 'Aetna Health & Life', amBest: 'A', states: ['MO', 'KS', 'TX', 'FL', 'AZ'], householdDiscountPct: 7, ratingMethod: 'attained_age', appointed: '2013' },
  'car-cig': { name: 'Cigna Healthcare', amBest: 'A', states: ['MO', 'KS', 'TX', 'FL'], householdDiscountPct: 10, ratingMethod: 'attained_age', appointed: '2014' },
  'car-hum': { name: 'Humana Achieve', amBest: 'A-', states: ['MO', 'TX', 'FL', 'AZ'], householdDiscountPct: 8, ratingMethod: 'issue_age', appointed: '2016' },
  'car-hgl': { name: 'Heartland Guaranty Life', amBest: 'A-', states: ['MO', 'KS'], householdDiscountPct: 14, ratingMethod: 'attained_age', appointed: '2026' },
};

/**
 * Approved rate filings by carrier and state: age-65 non-tobacco monthly
 * base premiums per plan, plus the filing's effective date.
 * BUG: Heartland Guaranty Life was appointed for MO and KS during 2026-Q3
 * onboarding (CARRIERS.car-hgl.states) but only its Kansas filing was loaded
 * here, so Missouri lookups for that carrier resolve `undefined`.
 */
const RATE_FILINGS = {
  'car-moo': {
    MO: { effective: '2026-04-01', plans: { G: 142.10, N: 108.45, HDG: 41.20, F: 189.60 } },
    KS: { effective: '2026-04-01', plans: { G: 138.75, N: 104.90, HDG: 39.85, F: 184.20 } },
    TX: { effective: '2026-01-01', plans: { G: 156.30, N: 117.80, HDG: 44.10, F: 211.40 } },
    FL: { effective: '2026-01-01', plans: { G: 231.90, N: 168.25, HDG: 58.70, F: 298.15 } },
    AZ: { effective: '2026-04-01', plans: { G: 149.40, N: 112.60, HDG: 42.35, F: 197.80 } },
  },
  'car-aet': {
    MO: { effective: '2026-06-01', plans: { G: 136.85, N: 103.20, HDG: 38.90, F: 181.75 } },
    KS: { effective: '2026-06-01', plans: { G: 133.40, N: 100.65, HDG: 37.95, F: 176.90 } },
    TX: { effective: '2026-03-01', plans: { G: 151.20, N: 113.55, HDG: 42.60, F: 203.30 } },
    FL: { effective: '2026-03-01', plans: { G: 224.60, N: 162.40, HDG: 56.80, F: 289.95 } },
    AZ: { effective: '2026-06-01', plans: { G: 144.15, N: 108.30, HDG: 40.75, F: 191.20 } },
  },
  'car-cig': {
    MO: { effective: '2026-05-01', plans: { G: 147.95, N: 110.70, HDG: 43.15, F: 195.40 } },
    KS: { effective: '2026-05-01', plans: { G: 143.60, N: 107.25, HDG: 41.80, F: 190.10 } },
    TX: { effective: '2026-02-01', plans: { G: 160.85, N: 120.40, HDG: 45.90, F: 216.25 } },
    FL: { effective: '2026-02-01', plans: { G: 238.40, N: 172.90, HDG: 60.25, F: 305.70 } },
  },
  'car-hum': {
    MO: { effective: '2026-07-01', plans: { G: 151.30, N: 114.85, HDG: 44.60, F: 199.90 } },
    TX: { effective: '2026-07-01', plans: { G: 164.75, N: 123.10, HDG: 47.30, F: 219.85 } },
    FL: { effective: '2026-07-01', plans: { G: 242.15, N: 176.30, HDG: 61.90, F: 311.40 } },
    AZ: { effective: '2026-07-01', plans: { G: 153.60, N: 116.20, HDG: 45.15, F: 203.45 } },
  },
  'car-hgl': {
    KS: { effective: '2026-09-01', plans: { G: 129.90, N: 97.40, HDG: 36.10, F: 171.50 } },
  },
};

/**
 * Attained-age rating factors relative to the age-65 base premium.
 */
const AGE_FACTORS = [
  { maxAge: 65, factor: 1.0 },
  { maxAge: 69, factor: 1.08 },
  { maxAge: 74, factor: 1.21 },
  { maxAge: 79, factor: 1.36 },
  { maxAge: 84, factor: 1.52 },
  { maxAge: 99, factor: 1.68 },
];

const GENDER_FACTORS = { female: 1.0, male: 1.09 };
const TOBACCO_FACTOR = 1.15;

/**
 * Enrollment windows the desk can submit an application under.
 */
const ENROLLMENT_WINDOWS = {
  open_enrollment: {
    label: 'Medigap Open Enrollment',
    description: 'Six months from Part B effective date — no medical underwriting',
    underwriting: 'none',
  },
  guaranteed_issue: {
    label: 'Guaranteed Issue right',
    description: 'Loss of coverage or trial right — of the plans this desk quotes, only Plan G (standard or high-deductible)',
    underwriting: 'none',
    eligiblePlans: ['G', 'HDG'],
  },
  underwritten: {
    label: 'Medically underwritten',
    description: 'Outside a protected window — health questions apply',
    underwriting: 'full',
  },
};

const EFFECTIVE_DATES = {
  next_month: { label: 'First of next month', monthsAhead: 1 },
  following_month: { label: 'First of the following month', monthsAhead: 2 },
};

const AGE_MIN = 64;
const AGE_MAX = 99;

function resolveState(stateCode) {
  const state = STATES[stateCode];
  if (!state) {
    throw Object.assign(new Error(`Unsupported state: ${stateCode}`), { code: 'INVALID_STATE' });
  }
  return state;
}

function zipInRatingArea(stateCode, zip) {
  const state = STATES[stateCode];
  return Boolean(state) && state.zipPrefixes.some((prefix) => zip.startsWith(prefix));
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function planFEligible(medicareEligibleDate) {
  return isCalendarDate(medicareEligibleDate) && medicareEligibleDate < PLAN_F_ELIGIBILITY_CUTOFF;
}

function ageFactor(age) {
  const bracket = AGE_FACTORS.find((b) => age <= b.maxAge) || AGE_FACTORS[AGE_FACTORS.length - 1];
  return bracket.factor;
}

function carriersAppointedIn(stateCode) {
  return Object.entries(CARRIERS)
    .filter(([, carrier]) => carrier.states.includes(stateCode))
    .map(([carrierId, carrier]) => ({ carrierId, ...carrier }));
}

/**
 * Prices one carrier's plan for the client from its approved state filing.
 * BUG: RATE_FILINGS['car-hgl'] has no MO filing, so `filing.plans` crashes.
 */
function priceCarrierPlan(carrier, stateCode, plan, client) {
  const filing = RATE_FILINGS[carrier.carrierId][stateCode];
  const base = filing.plans[plan];
  const factor = ageFactor(client.age)
    * GENDER_FACTORS[client.gender]
    * (client.tobacco ? TOBACCO_FACTOR : 1);
  const monthly = Math.round(base * factor * 100) / 100;
  const householdMonthly = Math.round(monthly * (1 - carrier.householdDiscountPct / 100) * 100) / 100;
  return {
    carrierId: carrier.carrierId,
    carrier: carrier.name,
    amBest: carrier.amBest,
    ratingMethod: carrier.ratingMethod,
    filingEffective: filing.effective,
    plan,
    baseMonthly: base,
    monthly,
    annual: Math.round(monthly * 12 * 100) / 100,
    householdDiscountPct: carrier.householdDiscountPct,
    householdMonthly,
  };
}

function compareCarriers(stateCode, plan, client) {
  const quotes = carriersAppointedIn(stateCode).map((carrier) => priceCarrierPlan(carrier, stateCode, plan, client));
  quotes.sort((a, b) => a.monthly - b.monthly);
  return quotes;
}

function effectiveDateFor(code, now = new Date()) {
  const opt = EFFECTIVE_DATES[code];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + opt.monthsAhead, 1));
  return d.toISOString().slice(0, 10);
}

function nextSteps(window, plan) {
  const steps = ['Review carrier comparison with client', 'Confirm Medicare Part A & B effective dates'];
  if (window.underwriting === 'full') steps.push('Complete health questionnaire and prescription review');
  if (window.eligiblePlans) steps.push(`Attach proof of guaranteed issue right (${PLANS[plan].label})`);
  steps.push('E-sign application and schedule Customer Success welcome call');
  return steps;
}

/**
 * Runs a Medicare Supplement carrier comparison for a client and opens the
 * enrollment case for the agent.
 */
async function runQuoteComparison(data) {
  const startTime = Date.now();
  const caseId = `SM-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Running SmartMatch Medicare Supplement quote comparison', {
    caseId,
    state: data.state,
    plan: data.plan,
    age: data.age,
    gender: data.gender,
    tobacco: data.tobacco,
    enrollmentWindow: data.enrollmentWindow,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const state = resolveState(data.state);
    const window = ENROLLMENT_WINDOWS[data.enrollmentWindow];
    const client = { age: data.age, gender: data.gender, tobacco: data.tobacco };
    const quotes = compareCarriers(data.state, data.plan, client);
    const best = quotes[0];
    const mostExpensive = quotes[quotes.length - 1];

    const duration = Date.now() - startTime;

    incrementMetric('medsupp_quote.compare.success', {
      route: ROUTE,
      state: data.state,
      plan: data.plan,
      enrollmentWindow: data.enrollmentWindow,
      carriers: String(quotes.length),
    });
    recordTiming('medsupp_quote.compare.latency', duration, { route: ROUTE });

    return {
      success: true,
      caseId,
      agentName: data.agentName,
      client: {
        firstName: data.clientFirstName,
        age: data.age,
        gender: data.gender,
        tobacco: data.tobacco,
        state: data.state,
        stateName: state.name,
        ratingArea: state.ratingArea,
        zip: data.zip,
        medicareEligibleDate: data.medicareEligibleDate,
      },
      plan: { code: data.plan, label: PLANS[data.plan].label, description: PLANS[data.plan].description },
      enrollment: {
        window: window.label,
        underwriting: window.underwriting,
        effectiveDate: effectiveDateFor(data.effectiveDate),
      },
      quotes,
      summary: {
        carriersCompared: quotes.length,
        lowestMonthly: best.monthly,
        lowestCarrier: best.carrier,
        annualSavingsVsHighest: Math.round((mostExpensive.monthly - best.monthly) * 12 * 100) / 100,
      },
      nextSteps: nextSteps(window, data.plan),
      status: 'comparison_ready',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('medsupp_quote.compare.failure', {
      route: ROUTE,
      errorClass: error.name,
      state: data.state,
      plan: data.plan,
    });
    recordTiming('medsupp_quote.compare.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('SmartMatch Medicare Supplement quote comparison failed', {
      caseId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      state: data.state,
      plan: data.plan,
      age: data.age,
      enrollmentWindow: data.enrollmentWindow,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'svg-smartmatch-agent-desk', alert_path: 'instant' },
      extra: {
        caseId,
        state: data.state,
        plan: data.plan,
        age: data.age,
        gender: data.gender,
        tobacco: data.tobacco,
        enrollmentWindow: data.enrollmentWindow,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/64e85fcf.js \u2014 priceCarrierPlan',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '64e85fcf',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Spring Venture Group \u2014 SmartMatch Medicare Supplement Quote',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'state', value: data.state },
        { key: 'plan', value: data.plan },
      ],
      extra: {
        caseId,
        state: data.state,
        plan: data.plan,
        age: data.age,
        enrollmentWindow: data.enrollmentWindow,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from SmartMatch quote error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  runQuoteComparison,
  resolveState,
  zipInRatingArea,
  isCalendarDate,
  planFEligible,
  carriersAppointedIn,
  priceCarrierPlan,
  compareCarriers,
  effectiveDateFor,
  STATES,
  PLANS,
  CARRIERS,
  RATE_FILINGS,
  AGE_FACTORS,
  GENDER_FACTORS,
  TOBACCO_FACTOR,
  ENROLLMENT_WINDOWS,
  EFFECTIVE_DATES,
  PLAN_F_ELIGIBILITY_CUTOFF,
  AGE_MIN,
  AGE_MAX,
};
