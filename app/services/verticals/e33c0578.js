const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.UKG_SLACK_MEMBER_ID || 'U0BU46F4WCU';

const PAY_GROUP = {
  id: 'PG-US-SEMI-01',
  name: 'Riverbend Health — Semi-Monthly (US)',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-15',
  payDate: '2026-09-20',
  fundingAccount: 'Operating ••4417',
};

// Work rules come from UKG Pro Workforce Management (time & attendance) and
// drive how worked hours convert into gross pay for the pay run.
const WORK_RULES = {
  'US-HOURLY-STD-40': {
    label: 'Standard 40-hour week',
    overtimeMultiplier: 1.5,
    doubleTimeMultiplier: 2,
    overtimeThresholdHours: 40,
    shiftDifferential: 0,
  },
  'US-NURSE-8-80': {
    label: 'Healthcare 8/80 (8h day, 80h period)',
    overtimeMultiplier: 1.5,
    doubleTimeMultiplier: 2,
    overtimeThresholdHours: 80,
    shiftDifferential: 2.25,
  },
  'US-SALARY-EXEMPT': {
    label: 'Salaried exempt',
    overtimeMultiplier: 0,
    doubleTimeMultiplier: 0,
    overtimeThresholdHours: 0,
    shiftDifferential: 0,
  },
  'US-NIGHT-12HR': {
    label: 'Night shift 12-hour rotation',
    overtimeMultiplier: 1.5,
    doubleTimeMultiplier: 2,
    overtimeThresholdHours: 40,
    shiftDifferential: 3.5,
  },
  'US-WEEKEND-ROTATION': {
    label: 'Weekend rotation (Northgate)',
    overtimeMultiplier: 1.5,
    doubleTimeMultiplier: 2,
    overtimeThresholdHours: 40,
    shiftDifferential: 1.75,
  },
};

const EMPLOYEES = [
  {
    id: 'E-100341',
    name: 'Alicia Moreno',
    jobTitle: 'Registered Nurse',
    location: 'Riverbend Medical Center',
    workRule: 'US-NURSE-8-80',
    payType: 'hourly',
    hourlyRate: 48.5,
    regularHours: 80,
    overtimeHours: 6,
    doubleTimeHours: 0,
  },
  {
    id: 'E-100388',
    name: 'Desmond Clark',
    jobTitle: 'Patient Access Specialist',
    location: 'Riverbend Medical Center',
    workRule: 'US-HOURLY-STD-40',
    payType: 'hourly',
    hourlyRate: 26.75,
    regularHours: 80,
    overtimeHours: 4.5,
    doubleTimeHours: 0,
  },
  {
    id: 'E-100412',
    name: 'Priya Raman',
    jobTitle: 'Director of Nursing',
    location: 'Riverbend Medical Center',
    workRule: 'US-SALARY-EXEMPT',
    payType: 'salary',
    semiMonthlySalary: 6250,
    regularHours: 0,
    overtimeHours: 0,
    doubleTimeHours: 0,
  },
  {
    id: 'E-100457',
    name: 'Tom Whitfield',
    jobTitle: 'Environmental Services Tech',
    location: 'Riverbend Medical Center',
    workRule: 'US-NIGHT-12HR',
    payType: 'hourly',
    hourlyRate: 22.4,
    regularHours: 80,
    overtimeHours: 8,
    doubleTimeHours: 2,
  },
  {
    id: 'E-100503',
    name: 'Grace Okonkwo',
    jobTitle: 'Surgical Tech',
    location: 'Northgate Surgery Center',
    // Northgate opened this period and runs the weekend rotation work rule.
    workRule: 'US-WEEKEND-ROTATION',
    payType: 'hourly',
    hourlyRate: 34.9,
    regularHours: 72,
    overtimeHours: 6,
    doubleTimeHours: 0,
    newLocation: true,
  },
  {
    id: 'E-100526',
    name: 'Martin Alvarez',
    jobTitle: 'Respiratory Therapist',
    location: 'Riverbend Medical Center',
    workRule: 'US-HOURLY-STD-40',
    payType: 'hourly',
    hourlyRate: 39.15,
    regularHours: 80,
    overtimeHours: 0,
    doubleTimeHours: 0,
  },
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the UKG Pro payroll gateway pay run submission:',
  '- Service: `app/services/verticals/e33c0578.js`',
  '- Route: `app/routes/verticals/e33c0578.js`',
  '- Page: `app/public/verticals/e33c0578.html` (served at `/ukg`)',
  '',
  'Gross pay is calculated per employee from the Workforce Management work rule',
  'assigned to them. Keep the calculated pay identical for every work rule that is',
  'already registered — the fix must not change existing amounts.',
  'Run `npx jest tests/e33c0578-pay-run.test.js --runInBand` and `npm run lint`.',
  'Verify the pay run at `/ukg` submits successfully with every employee selected.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validatePayRun(data) {
  if (!data.payGroupId || data.payGroupId !== PAY_GROUP.id) {
    const error = new Error('Select a valid pay group before submitting.');
    error.name = 'ValidationError';
    error.code = 'PAY_GROUP_INVALID';
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(data.employeeIds) || data.employeeIds.length === 0) {
    const error = new Error('Select at least one employee to include in this pay run.');
    error.name = 'ValidationError';
    error.code = 'NO_EMPLOYEES_SELECTED';
    error.statusCode = 400;
    throw error;
  }

  const unknownEmployeeIds = data.employeeIds
    .filter((employeeId) => !EMPLOYEES.some((employee) => employee.id === employeeId));
  if (unknownEmployeeIds.length > 0) {
    const error = new Error(`Unknown employee ID(s) for this pay group: ${unknownEmployeeIds.join(', ')}`);
    error.name = 'ValidationError';
    error.code = 'UNKNOWN_EMPLOYEE';
    error.statusCode = 400;
    throw error;
  }
}

function resolveWorkRule(employee) {
  return WORK_RULES[employee.workRule];
}

function requireWorkRule(employee) {
  const workRule = resolveWorkRule(employee);
  if (!workRule) {
    const error = new Error(
      `No payroll work rule is registered for '${employee.workRule}' (employee ${employee.id}).`,
    );
    error.name = 'ValidationError';
    error.code = 'WORK_RULE_NOT_REGISTERED';
    error.statusCode = 422;
    throw error;
  }
  return workRule;
}

function calculateGrossPay(employee) {
  const workRule = requireWorkRule(employee);

  if (employee.payType === 'salary') {
    return {
      employeeId: employee.id,
      name: employee.name,
      workRule: workRule.label,
      regularPay: employee.semiMonthlySalary,
      premiumPay: 0,
      grossPay: employee.semiMonthlySalary,
    };
  }

  const regularPay = employee.regularHours * employee.hourlyRate;
  const shiftPay = employee.regularHours * workRule.shiftDifferential;
  const overtimePay = employee.overtimeHours * employee.hourlyRate * workRule.overtimeMultiplier;
  const doubleTimePay = employee.doubleTimeHours * employee.hourlyRate * workRule.doubleTimeMultiplier;
  const premiumPay = Math.round((shiftPay + overtimePay + doubleTimePay) * 100) / 100;

  return {
    employeeId: employee.id,
    name: employee.name,
    workRule: workRule.label,
    regularPay: Math.round(regularPay * 100) / 100,
    premiumPay,
    grossPay: Math.round((regularPay + premiumPay) * 100) / 100,
  };
}

function buildPayRunSummary(confirmationId, selectedEmployees) {
  const lines = selectedEmployees.map(calculateGrossPay);
  const totalGross = Math.round(lines.reduce((sum, line) => sum + line.grossPay, 0) * 100) / 100;

  return {
    success: true,
    confirmation: confirmationId,
    status: 'submitted_to_treasury',
    payGroup: PAY_GROUP.name,
    payDate: PAY_GROUP.payDate,
    fundingAccount: PAY_GROUP.fundingAccount,
    employeeCount: lines.length,
    totalGross,
    lines,
  };
}

function getPayRun() {
  return {
    payGroup: PAY_GROUP,
    employees: EMPLOYEES.map((employee) => ({
      ...employee,
      workRuleLabel: (WORK_RULES[employee.workRule] || {}).label || employee.workRule,
      shiftDifferential: (WORK_RULES[employee.workRule] || {}).shiftDifferential || 0,
    })),
  };
}

async function submitPayRun(data) {
  const startTime = Date.now();
  const confirmationId = `PR-${uuidv4().slice(0, 8).toUpperCase()}`;

  validatePayRun(data);

  const selectedEmployees = EMPLOYEES.filter((employee) => data.employeeIds.includes(employee.id));

  logger.info('Submitting UKG Pro pay run', {
    confirmationId,
    payGroupId: data.payGroupId,
    employeeCount: selectedEmployees.length,
    service: 'customer-e33c0578-pay-run',
    route: '/api/e33c0578/pay-run',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 150));

    const result = buildPayRunSummary(confirmationId, selectedEmployees);
    const duration = Date.now() - startTime;

    incrementMetric('pay_run.submission_success', {
      route: '/api/e33c0578/pay-run',
      payGroup: PAY_GROUP.id,
      employees: String(result.employeeCount),
    });
    recordTiming('pay_run.submission_latency', duration, {
      route: '/api/e33c0578/pay-run',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('pay_run.submission_failure', {
      route: '/api/e33c0578/pay-run',
      payGroup: PAY_GROUP.id,
      errorClass: error.name,
    });
    recordTiming('pay_run.submission_latency', duration, {
      route: '/api/e33c0578/pay-run',
      error: 'true',
    });

    logger.error('UKG Pro pay run submission failed', {
      confirmationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      payGroupId: data.payGroupId,
      employeeCount: selectedEmployees.length,
      service: 'customer-e33c0578-pay-run',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/e33c0578/pay-run',
        service: 'customer-e33c0578-pay-run',
        payGroup: PAY_GROUP.id,
        alert_path: 'instant',
      },
      extra: {
        confirmationId,
        payPeriod: `${PAY_GROUP.periodStart} → ${PAY_GROUP.periodEnd}`,
        employeeIds: data.employeeIds,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e33c0578.js — calculateGrossPay',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-e33c0578-pay-run',
      verticalLabel: 'UKG Pro Payroll Gateway',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'e33c0578',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: '/api/e33c0578/pay-run' },
        { key: 'service', value: 'customer-e33c0578-pay-run' },
        { key: 'payGroup', value: PAY_GROUP.id },
        { key: 'payDate', value: PAY_GROUP.payDate },
      ],
      extra: {
        confirmationId,
        payPeriod: `${PAY_GROUP.periodStart} → ${PAY_GROUP.periodEnd}`,
        employeeIds: data.employeeIds,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-e33c0578-pay-run@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for UKG pay run error', {
        error: alertError.message,
        confirmationId,
      });
    });

    throw error;
  }
}

module.exports = {
  submitPayRun,
  getPayRun,
  calculateGrossPay,
  resolveWorkRule,
  requireWorkRule,
  buildPayRunSummary,
  PAY_GROUP,
  EMPLOYEES,
  WORK_RULES,
  REMEDIATION_DIRECTIVE,
};
