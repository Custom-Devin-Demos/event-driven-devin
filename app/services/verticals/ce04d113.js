const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-ce04d113-account-signup';
const ROUTE = '/api/ce04d113/create-account';
const SLACK_MEMBER_ID = 'U08S7AVJ478';

/**
 * Self-serve plans offered on the marketing site. `primaryRegistration` names
 * the tax registration the onboarding timeline is anchored to — the first
 * payroll cannot be scheduled before that registration clears.
 */
const PLAN_TIERS = {
  simple: {
    label: 'Simple',
    basePriceUsd: 49,
    perPersonUsd: 6,
    primaryRegistration: 'withholding',
    onboardingTasks: ['company_profile', 'team_invites', 'bank_verification'],
  },
  plus: {
    label: 'Plus',
    basePriceUsd: 80,
    perPersonUsd: 12,
    primaryRegistration: 'withholding',
    onboardingTasks: ['company_profile', 'team_invites', 'bank_verification', 'time_tracking'],
  },
  premium: {
    label: 'Premium',
    basePriceUsd: 180,
    perPersonUsd: 22,
    primaryRegistration: 'unemployment',
    onboardingTasks: ['company_profile', 'team_invites', 'bank_verification', 'time_tracking', 'hr_advisory'],
  },
};

/**
 * Agencies a new company registers with before its first payroll, by state.
 * `leadDays` is the agency's published turnaround for a new employer account.
 */
const STATE_TAX_AGENCIES = {
  MN: [
    { agencyCode: 'MN-DOR', agencyName: 'Minnesota Department of Revenue', role: 'withholding', leadDays: 3 },
    { agencyCode: 'MN-UI', agencyName: 'Minnesota Unemployment Insurance', role: 'unemployment', leadDays: 5 },
  ],
  CA: [
    { agencyCode: 'CA-EDD', agencyName: 'California Employment Development Department', role: 'withholding', leadDays: 2 },
    { agencyCode: 'CA-EDD-UI', agencyName: 'California EDD Unemployment Insurance', role: 'unemployment', leadDays: 4 },
  ],
  NY: [
    { agencyCode: 'NY-DTF', agencyName: 'New York Department of Taxation and Finance', role: 'withholding', leadDays: 4 },
    { agencyCode: 'NY-DOL', agencyName: 'New York Department of Labor', role: 'unemployment', leadDays: 6 },
  ],
  TX: [
    { agencyCode: 'TX-TWC', agencyName: 'Texas Workforce Commission', role: 'unemployment', leadDays: 3 },
  ],
};

const PAY_FREQUENCIES = {
  weekly: { label: 'Weekly', runsPerYear: 52, cutoffDays: 2 },
  biweekly: { label: 'Every other week', runsPerYear: 26, cutoffDays: 3 },
  semimonthly: { label: 'Twice a month', runsPerYear: 24, cutoffDays: 3 },
  monthly: { label: 'Monthly', runsPerYear: 12, cutoffDays: 4 },
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
  'The failing code path is the Gusto marketing-site account signup vertical:',
  '- Service: `app/services/verticals/ce04d113.js`',
  '- Route: `app/routes/verticals/ce04d113.js`',
  '- Page: `app/public/verticals/ce04d113.html` (served at `/ce04d113`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Registrations a company in the given state must open before payroll runs.
 */
function deriveTaxRegistrations(state) {
  const agencies = STATE_TAX_AGENCIES[state] || STATE_TAX_AGENCIES.CA;

  return agencies.map((agency) => ({
    agencyCode: agency.agencyCode,
    agencyName: agency.agencyName,
    role: agency.role,
    leadDays: agency.leadDays,
    status: 'pending',
  }));
}

/**
 * Index the registrations so the onboarding steps can look one up by the role
 * it fills for the company rather than scanning the list each time.
 */
function buildRegistrationIndex(registrations) {
  const index = {};

  for (const registration of registrations) {
    index[registration.agency] = registration;
  }

  return index;
}

/**
 * Build the onboarding checklist shown after signup.
 */
function buildOnboardingChecklist(tier, registrations) {
  const tasks = tier.onboardingTasks.map((code) => ({
    code,
    status: 'todo',
  }));

  for (const registration of registrations) {
    tasks.push({
      code: `register_${registration.role}`,
      agency: registration.agencyName,
      status: registration.status,
    });
  }

  return tasks;
}

/**
 * Estimate when the company can run its first payroll: the anchor registration
 * has to clear, then the pay-period cutoff for the chosen frequency applies.
 */
function estimateSetupTimeline(registrationIndex, tier, payFrequency) {
  const cadence = PAY_FREQUENCIES[payFrequency] || PAY_FREQUENCIES.biweekly;
  const anchor = registrationIndex[tier.primaryRegistration];
  const totalDays = anchor.leadDays + cadence.cutoffDays;

  const firstPayrollDate = new Date(Date.now() + totalDays * 86400000);

  return {
    anchorAgency: anchor.agencyName,
    registrationLeadDays: anchor.leadDays,
    cutoffDays: cadence.cutoffDays,
    payCadence: cadence.label,
    firstPayrollDate: firstPayrollDate.toISOString().slice(0, 10),
  };
}

/**
 * Monthly subscription price quoted on the confirmation screen.
 */
function quoteSubscription(tier, employeeCount) {
  const people = Math.max(1, Number(employeeCount) || 1);
  const monthly = tier.basePriceUsd + tier.perPersonUsd * people;

  return {
    plan: tier.label,
    people,
    monthlyUsd: Math.round(monthly * 100) / 100,
  };
}

/**
 * Create a self-serve Gusto account from the marketing site.
 */
async function createAccount(data) {
  const startTime = Date.now();
  const companyId = uuidv4();
  const plan = data.plan || 'simple';
  const primaryState = data.primaryState || 'CA';

  logger.info('Creating self-serve account', {
    companyId,
    plan,
    primaryState,
    employeeCount: data.employeeCount,
    payFrequency: data.payFrequency,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const tier = PLAN_TIERS[plan] || PLAN_TIERS.simple;
    const registrations = deriveTaxRegistrations(primaryState);
    const registrationIndex = buildRegistrationIndex(registrations);
    const timeline = estimateSetupTimeline(registrationIndex, tier, data.payFrequency);
    const checklist = buildOnboardingChecklist(tier, registrations);
    const subscription = quoteSubscription(tier, data.employeeCount);

    const duration = Date.now() - startTime;

    incrementMetric('account_signup.success', { route: ROUTE, plan });
    recordTiming('account_signup.latency', duration, { route: ROUTE });

    return {
      success: true,
      companyId,
      companyName: data.companyName || 'New company',
      plan: tier.label,
      state: primaryState,
      subscription,
      checklist,
      anchorAgency: timeline.anchorAgency,
      firstPayrollDate: timeline.firstPayrollDate,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('account_signup.failure', {
      route: ROUTE,
      errorClass: error.name,
      plan,
      state: primaryState,
    });
    recordTiming('account_signup.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Self-serve account creation failed', {
      companyId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      plan,
      primaryState,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        plan,
        state: primaryState,
        alert_path: 'instant',
      },
      extra: {
        companyId,
        plan,
        primaryState,
        employeeCount: data.employeeCount,
        payFrequency: data.payFrequency,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ce04d113.js \u2014 estimateSetupTimeline',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Account Signup',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'ce04d113',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'plan', value: plan },
        { key: 'state', value: primaryState },
      ],
      extra: {
        companyId,
        plan,
        primaryState,
        employeeCount: data.employeeCount,
        payFrequency: data.payFrequency,
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
      logger.error('Failed to create Devin session for account signup error', {
        error: err.message,
        companyId,
      });
    });

    throw error;
  }
}

module.exports = {
  createAccount,
  REMEDIATION_DIRECTIVE,
  PLAN_TIERS,
  STATE_TAX_AGENCIES,
  PAY_FREQUENCIES,
  deriveTaxRegistrations,
  buildRegistrationIndex,
  buildOnboardingChecklist,
  estimateSetupTimeline,
  quoteSubscription,
};
