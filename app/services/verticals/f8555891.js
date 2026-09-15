const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { declareDatadogIncident } = require('../datadog-incidents');

const SERVICE = 'customer-f8555891-payroll';
const ROUTE = '/api/f8555891/release-batch';

const BATCH = {
  id: 'PB-2026-09-15-A',
  payDate: '2026-09-17',
  debitWindow: '2026-09-15 14:00 PT',
  achCutoff: '2026-09-15 17:30 PT',
  processor: 'ach-origination-east',
};

const COMPANIES = [
  {
    id: 'CO-48211',
    name: 'Harbor Light Coffee Roasters',
    industry: 'Food & Beverage',
    plan: 'Plus',
    employees: 42,
    workStates: ['CA'],
    grossPay: 148200,
    status: 'ready',
  },
  {
    id: 'CO-50934',
    name: 'Redwood Ridge Veterinary',
    industry: 'Healthcare',
    plan: 'Premium',
    employees: 27,
    workStates: ['CA', 'WA'],
    grossPay: 96400,
    status: 'ready',
  },
  {
    id: 'CO-51177',
    name: 'Northstar Dental Group',
    industry: 'Healthcare',
    plan: 'Plus',
    employees: 19,
    workStates: ['MN'],
    grossPay: 71300,
    status: 'ready',
    newState: true,
  },
  {
    id: 'CO-47102',
    name: 'Brightline Architecture Studio',
    industry: 'Professional Services',
    plan: 'Simple',
    employees: 11,
    workStates: ['NY'],
    grossPay: 58900,
    status: 'ready',
  },
  {
    id: 'CO-52260',
    name: 'Mesa Verde Landscaping',
    industry: 'Field Services',
    plan: 'Simple',
    employees: 34,
    workStates: ['TX'],
    grossPay: 64800,
    status: 'ready',
  },
];

const STATE_PAYROLL_PROGRAMS = {
  CA: { jurisdiction: 'California', programs: ['ca_sdi', 'ca_ett', 'ca_ui'], employerRate: 0.034, employeeRate: 0.011 },
  WA: { jurisdiction: 'Washington', programs: ['wa_pfml', 'wa_cares', 'wa_ui'], employerRate: 0.028, employeeRate: 0.0132 },
  NY: { jurisdiction: 'New York', programs: ['ny_pfl', 'ny_sdi', 'ny_ui'], employerRate: 0.041, employeeRate: 0.00455 },
  TX: { jurisdiction: 'Texas', programs: ['tx_ui'], employerRate: 0.027, employeeRate: 0 },
};

function resolveStatePrograms(state) {
  return STATE_PAYROLL_PROGRAMS[state];
}

function computeCompanyDebit(company) {
  let employerContributions = 0;
  let employeeWithholding = 0;
  const jurisdictions = [];

  company.workStates.forEach((state) => {
    const programs = resolveStatePrograms(state);
    const share = company.grossPay / company.workStates.length;
    employerContributions += share * programs.employerRate;
    employeeWithholding += share * programs.employeeRate;
    jurisdictions.push(programs.jurisdiction);
  });

  const round = (value) => Math.round(value * 100) / 100;
  return {
    employerContributions: round(employerContributions),
    employeeWithholding: round(employeeWithholding),
    totalDebit: round(company.grossPay + employerContributions),
    jurisdictions,
  };
}

function getBatchCompanies() {
  return COMPANIES.map((company) => {
    const round = (value) => Math.round(value * 100) / 100;
    const employerContributions = company.workStates.reduce((sum, state) => {
      const programs = resolveStatePrograms(state);
      return programs ? sum + (company.grossPay / company.workStates.length) * programs.employerRate : sum;
    }, 0);
    return {
      ...company,
      employerContributions: round(employerContributions),
      totalDebit: round(company.grossPay + employerContributions),
    };
  });
}

const REMEDIATION_DIRECTIVE = [
  '!payroll_tax_triage',
  '',
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Gusto Payroll Operations on-call console, "Release ACH debits" for a payroll batch:',
  '- Service: `app/services/verticals/f8555891.js`',
  '- Route: `app/routes/verticals/f8555891.js`',
  '- Page: `app/public/verticals/f8555891.html` (served at `/gusto`)',
  '',
  'Before changing code, pull the runtime evidence through your MCP integrations:',
  `- Sentry MCP: find the latest \`TypeError\` issue for service \`${SERVICE}\` and read its stack trace and tags (\`batchId\`, \`companyId\`, \`state\`, \`route\`).`,
  '- Datadog MCP: query the `gusto_payroll.batch_release_failure` metric by `state` tag and the open SEV-2 incident titled "Payroll batch release failing for Minnesota employers"; confirm that companies with MN employees fail while other states debit successfully.',
  'Fix the root cause (the state payroll-program registry — register MN with its paid-leave and UI programs, not the crash site), add regression coverage in `tests/gusto-payroll-batch-release.test.js`, and resolve the Datadog incident in the PR description.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

async function releaseBatch(data) {
  const startTime = Date.now();
  const batchId = data.batchId;
  let companyIds;

  const validationError = (message, code) => {
    const err = new Error(message);
    err.name = 'ValidationError';
    err.code = code;
    err.statusCode = 400;
    return err;
  };

  if (batchId !== BATCH.id) {
    throw validationError(`Unknown payroll batch: ${batchId || '(none)'}`, 'UNKNOWN_BATCH');
  }

  if (data.companyIds === undefined) {
    companyIds = COMPANIES.map((company) => company.id);
  } else if (!Array.isArray(data.companyIds)) {
    throw validationError('companyIds must be an array of company IDs', 'INVALID_COMPANY_SELECTION');
  } else {
    companyIds = [...new Set(data.companyIds)];
  }

  if (companyIds.length === 0) {
    throw validationError('Batch release must include at least one company', 'EMPTY_BATCH');
  }

  const unknownCompanyIds = companyIds.filter((id) => !COMPANIES.some((company) => company.id === id));
  if (unknownCompanyIds.length > 0) {
    throw validationError(`Unknown company ID(s): ${unknownCompanyIds.join(', ')}`, 'UNKNOWN_COMPANY');
  }

  const selectedCompanies = COMPANIES.filter((company) => companyIds.includes(company.id));
  let failingCompany = null;

  logger.info('Releasing Gusto payroll batch', {
    batchId,
    companyCount: selectedCompanies.length,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const debits = selectedCompanies.map((company) => {
      failingCompany = company;
      const debit = computeCompanyDebit(company);
      return {
        companyId: company.id,
        companyName: company.name,
        employees: company.employees,
        grossPay: company.grossPay,
        employerContributions: debit.employerContributions,
        employeeWithholding: debit.employeeWithholding,
        totalDebit: debit.totalDebit,
        jurisdictions: debit.jurisdictions,
      };
    });
    failingCompany = null;

    const totalDebit = debits.reduce((sum, debit) => sum + debit.totalDebit, 0);
    const totalEmployees = debits.reduce((sum, debit) => sum + debit.employees, 0);
    const duration = Date.now() - startTime;

    incrementMetric('gusto_payroll.batch_release_success', { batchId });
    recordTiming('gusto_payroll.batch_release_latency', duration, { batchId, error: 'false' });

    return {
      batchId,
      status: 'released',
      achFileId: `ACH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      payDate: BATCH.payDate,
      companyCount: debits.length,
      totalEmployees,
      totalDebit: Math.round(totalDebit * 100) / 100,
      debits,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const state = failingCompany
      ? failingCompany.workStates.find((workState) => !resolveStatePrograms(workState)) || failingCompany.workStates[0]
      : undefined;

    incrementMetric('gusto_payroll.batch_release_failure', {
      batchId,
      ...(state ? { state } : {}),
    });
    recordTiming('gusto_payroll.batch_release_latency', duration, {
      batchId,
      ...(state ? { state } : {}),
      error: 'true',
    });

    logger.error('Gusto payroll batch release failed', {
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      batchId,
      companyId: failingCompany ? failingCompany.id : undefined,
      state,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        batchId,
        state: state || 'unknown',
        alert_path: 'instant',
      },
      extra: {
        batchId,
        ...(failingCompany ? { companyId: failingCompany.id } : {}),
      },
    });

    declareDatadogIncident({
      title: 'Payroll batch release failing for Minnesota employers',
      summary: `${error.name}: ${error.message}. Batch ${batchId} cannot compute employer contributions for companies with employees working in MN; ACH debits for the batch are blocked ahead of the ${BATCH.achCutoff} cutoff.`,
      runRef: batchId,
      service: SERVICE,
      triggeredBy: data.devinEmail || 'payroll-oncall',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((err) => logger.warn('Failed to declare Datadog incident for Gusto payroll', { error: err.message, batchId }));

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f8555891.js — computeCompanyDebit',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Gusto Payroll Batch Release',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'f8555891',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'batchId', value: batchId },
        { key: 'state', value: state || 'unknown' },
      ],
      extra: {
        batchId,
        ...(failingCompany ? { companyId: failingCompany.id } : {}),
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
    }).catch((err) => logger.warn('Gusto payroll incident follow-up failed', { error: err.message, batchId }));

    throw error;
  }
}

module.exports = {
  releaseBatch,
  BATCH,
  COMPANIES,
  getBatchCompanies,
  STATE_PAYROLL_PROGRAMS,
  REMEDIATION_DIRECTIVE,
};
