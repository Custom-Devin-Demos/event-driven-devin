const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { declareDatadogIncident } = require('../datadog-incidents');
const {
  createLinearIssue,
  addLinearComment,
  updateLinearIssueState,
} = require('../linear');

const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID_A7FB8819 || '3c9f0e1e-54da-442d-8949-a62489060822';
const LINEAR_ASSIGNEE_ID = process.env.LINEAR_ASSIGNEE_ID_A7FB8819 || '4d616028-0c12-4ad9-b117-0661170e857e';
const LINEAR_STATE_IN_PROGRESS_ID = process.env.LINEAR_STATE_IN_PROGRESS_A7FB8819 || '99c9b96f-39b3-4a09-9112-53c054f3dbab';
const LINEAR_STATE_IN_REVIEW_ID = process.env.LINEAR_STATE_IN_REVIEW_A7FB8819 || 'd79ea314-a400-4382-9140-d4861fb4e30f';

const PAY_RUN = {
  id: 'PR-2026-09-15',
  payPeriod: 'Sep 1 – Sep 15, 2026',
  payDate: '2026-09-19',
  payFrequency: 'semi-monthly',
};

const EMPLOYEES = [
  {
    id: 'EMP-1001',
    name: 'Ava Chen',
    title: 'Senior Product Manager',
    department: 'Product',
    workState: 'CA',
    payType: 'salary',
    grossPay: 8500,
    newHire: false,
  },
  {
    id: 'EMP-1002',
    name: 'Marcus Rivera',
    title: 'Payroll Specialist',
    department: 'People Operations',
    workState: 'NY',
    payType: 'salary',
    grossPay: 6200,
    newHire: false,
  },
  {
    id: 'EMP-1003',
    name: 'Jordan Brooks',
    title: 'Warehouse Lead',
    department: 'Operations',
    workState: 'TX',
    payType: 'hourly',
    grossPay: 4100,
    hoursWorked: 80,
    newHire: false,
  },
  {
    id: 'EMP-1004',
    name: 'Elena Petrov',
    title: 'Customer Success Manager',
    department: 'Customer Success',
    workState: 'WA',
    payType: 'salary',
    grossPay: 7000,
    newHire: false,
  },
  {
    id: 'EMP-1005',
    name: 'Samuel Ortiz',
    title: 'Sales Director',
    department: 'Sales',
    workState: 'CA',
    payType: 'salary',
    grossPay: 9200,
    newHire: false,
  },
  {
    id: 'EMP-1006',
    name: 'Priya Natarajan',
    title: 'Staff Software Engineer',
    department: 'Engineering',
    workState: 'CO',
    payType: 'salary',
    grossPay: 7800,
    newHire: true,
  },
];

const STATE_WITHHOLDING_POLICIES = {
  CA: {
    jurisdiction: 'California',
    withholdingRate: 0.093,
    sdiRate: 0.009,
    pflRate: 0.009,
    filingFrequency: 'monthly',
  },
  NY: {
    jurisdiction: 'New York',
    withholdingRate: 0.085,
    sdiRate: 0.005,
    pflRate: 0.005,
    filingFrequency: 'monthly',
  },
  TX: {
    jurisdiction: 'Texas',
    withholdingRate: 0,
    sdiRate: null,
    pflRate: null,
    filingFrequency: 'quarterly',
  },
  WA: {
    jurisdiction: 'Washington',
    withholdingRate: 0,
    sdiRate: null,
    pflRate: 0.0074,
    filingFrequency: 'quarterly',
  },
};

function resolveWithholdingPolicy(employee) {
  return STATE_WITHHOLDING_POLICIES[employee.workState];
}

function computeWithholding(employee) {
  const policy = resolveWithholdingPolicy(employee);
  const stateWithholding = Math.round(employee.grossPay * policy.withholdingRate * 100) / 100;

  return {
    stateWithholding,
    netPay: Math.round((employee.grossPay - stateWithholding) * 100) / 100,
    jurisdiction: policy.jurisdiction,
  };
}

function getPayRunEmployees() {
  return EMPLOYEES.map((employee) => {
    const policy = resolveWithholdingPolicy(employee);
    const stateWithholding = policy
      ? Math.round(employee.grossPay * policy.withholdingRate * 100) / 100
      : 0;

    return {
      ...employee,
      stateWithholding,
      netPay: Math.round((employee.grossPay - stateWithholding) * 100) / 100,
      employerTaxes: Math.round(employee.grossPay * 0.08 * 100) / 100,
    };
  });
}

const REMEDIATION_DIRECTIVE = [
  '!payroll_tax_triage',
  '',
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Rippling Payroll pay-run submission screen for Northwind Robotics:',
  '- Service: `app/services/verticals/a7fb8819.js`',
  '- Route: `app/routes/verticals/a7fb8819.js`',
  '- Page: `app/public/verticals/a7fb8819.html` (served at `/rippling`)',
  '',
  'Before changing code, pull the runtime evidence through your MCP integrations:',
  '- Sentry MCP: find the latest `TypeError` issue for service `customer-a7fb8819-payroll` and read its stack trace and tags (`payRunId`, `state`, `route`).',
  '- Datadog MCP: query the `rippling_payroll.pay_run_failure` metric by `state` tag and the open SEV-2 incident titled "Rippling payroll submission failing for Colorado employees"; confirm that Colorado employees fail while other states succeed.',
  'Fix the root cause (the state withholding policy map — register CO, not the crash site), add regression coverage in `tests/rippling-payroll-submission.test.js`, and resolve the Datadog incident in the PR description.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function buildRemediationDirective(issue) {
  if (!issue) return REMEDIATION_DIRECTIVE;

  return [
    REMEDIATION_DIRECTIVE,
    '',
    `*Linear ticket:* ${issue.identifier} — ${issue.url}`,
    'The app moves the ticket to In Progress and comments your session link right after your session is created. If either update is missing, perform only that update yourself first. Ticket lifecycle you own:',
    `- As soon as your PR is open: comment on the ticket with the PR URL (Linear MCP \`create_comment\` / or the GraphQL API with \`LINEAR_API_KEY\`), add the PR link to the ticket, and move the ticket to the "In Review" state (id '${LINEAR_STATE_IN_REVIEW_ID}').`,
    '- Do NOT move the ticket to Done. The reviewer moves it to Done after approving and merging the PR.',
    '- If you push follow-up commits after review feedback, leave the ticket In Review and add a short comment.',
  ].join('\n');
}

async function submitPayRun(data) {
  const startTime = Date.now();
  const payRunId = data.payRunId;
  let employeeIds;

  if (payRunId !== PAY_RUN.id) {
    const validationError = new Error(`Unknown pay run: ${payRunId || '(none)'}`);
    validationError.name = 'ValidationError';
    validationError.code = 'UNKNOWN_PAY_RUN';
    validationError.statusCode = 400;
    throw validationError;
  }

  if (data.employeeIds === undefined) {
    employeeIds = EMPLOYEES.map((employee) => employee.id);
  } else if (!Array.isArray(data.employeeIds)) {
    const validationError = new Error('employeeIds must be an array of employee IDs');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_EMPLOYEE_SELECTION';
    validationError.statusCode = 400;
    throw validationError;
  } else {
    employeeIds = [...new Set(data.employeeIds)];
  }

  if (employeeIds.length === 0) {
    const validationError = new Error('Pay run must include at least one employee');
    validationError.name = 'ValidationError';
    validationError.code = 'EMPTY_PAY_RUN';
    validationError.statusCode = 400;
    throw validationError;
  }

  const unknownEmployeeIds = employeeIds.filter((employeeId) => !EMPLOYEES.some((employee) => employee.id === employeeId));
  if (unknownEmployeeIds.length > 0) {
    const validationError = new Error(`Unknown employee ID(s): ${unknownEmployeeIds.join(', ')}`);
    validationError.name = 'ValidationError';
    validationError.code = 'UNKNOWN_EMPLOYEE';
    validationError.statusCode = 400;
    throw validationError;
  }

  const selectedEmployees = EMPLOYEES.filter((employee) => employeeIds.includes(employee.id));
  let failingEmployee = null;

  logger.info('Submitting Rippling payroll pay run', {
    payRunId,
    employeeCount: selectedEmployees.length,
    service: 'customer-a7fb8819-payroll',
    route: '/api/a7fb8819/submit-pay-run',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const employees = selectedEmployees.map((employee) => {
      failingEmployee = employee;
      const withholding = computeWithholding(employee);
      return {
        employeeId: employee.id,
        grossPay: employee.grossPay,
        stateWithholding: withholding.stateWithholding,
        netPay: withholding.netPay,
        jurisdiction: withholding.jurisdiction,
      };
    });
    const totalGross = employees.reduce((sum, employee) => sum + employee.grossPay, 0);
    const totalNet = employees.reduce((sum, employee) => sum + employee.netPay, 0);
    const duration = Date.now() - startTime;

    incrementMetric('rippling_payroll.pay_run_success', { payRunId });
    recordTiming('rippling_payroll.pay_run_latency', duration, {
      payRunId,
      error: 'false',
    });

    return {
      payRunId,
      status: 'submitted',
      confirmation: `RPL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      payDate: PAY_RUN.payDate,
      employeeCount: employees.length,
      totalGross,
      totalNet,
      employees,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const state = failingEmployee ? failingEmployee.workState : undefined;

    incrementMetric('rippling_payroll.pay_run_failure', {
      payRunId,
      ...(state ? { state } : {}),
    });
    recordTiming('rippling_payroll.pay_run_latency', duration, {
      payRunId,
      ...(state ? { state } : {}),
      error: 'true',
    });

    logger.error('Rippling payroll pay-run submission failed', {
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      payRunId,
      state,
      service: 'customer-a7fb8819-payroll',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/a7fb8819/submit-pay-run',
        service: 'customer-a7fb8819-payroll',
        payRunId,
        state: state || 'unknown',
        alert_path: 'instant',
      },
      extra: {
        payRunId,
        ...(failingEmployee ? { employeeId: failingEmployee.id } : {}),
      },
    });

    declareDatadogIncident({
      title: 'Rippling payroll submission failing for Colorado employees',
      summary: `${error.name}: ${error.message}. Pay run ${payRunId} cannot compute state withholding for employees working in CO.`,
      runRef: payRunId,
      service: 'customer-a7fb8819-payroll',
      triggeredBy: data.devinEmail || 'payroll',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((err) => logger.warn('Failed to declare Datadog incident for Rippling payroll', { error: err.message, payRunId }));

    (async () => {
      let issue = null;
      try {
        issue = await createLinearIssue({
          title: `[Rippling payroll] ${error.name}: ${error.message}`,
          description: [
            'Rippling payroll submission cannot compute state withholding for an employee in Colorado.',
            '',
            '- Service: `customer-a7fb8819-payroll`',
            '- Route: `POST /api/a7fb8819/submit-pay-run`',
            `- Pay run: \`${payRunId}\``,
            `- Error: \`${error.name}: ${error.message}\``,
            '',
            'Repository: https://github.com/COG-GTM/event-driven-devin (`app/services/verticals/a7fb8819.js`).',
            'Sentry has the stack trace for this service; Datadog has a SEV-2 incident "Rippling payroll submission failing for Colorado employees".',
            '',
            'Triage with the `!payroll_tax_triage` playbook.',
          ].join('\n'),
          teamId: LINEAR_TEAM_ID,
          assigneeId: LINEAR_ASSIGNEE_ID,
          priority: 2,
        });
      } catch (err) {
        logger.warn('Failed to create Linear issue for Rippling payroll', { error: err.message, payRunId });
      }

      const outcome = await createSessionAndAlert({
        issueTitle: `${error.name}: ${error.message}`,
        issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
        culprit: 'app/services/verticals/a7fb8819.js — computeWithholding',
        errorType: error.name || 'Error',
        errorValue: error.message,
        devinUserId: data.devinUserId,
        devinEmail: data.devinEmail,
        devinOrgId: data.devinOrgId,
        service: 'customer-a7fb8819-payroll',
        verticalLabel: 'Rippling Payroll Pay Run',
        promptAppendix: buildRemediationDirective(issue),
        customer: 'a7fb8819',
        tags: [
          { key: 'route', value: '/api/a7fb8819/submit-pay-run' },
          { key: 'service', value: 'customer-a7fb8819-payroll' },
          { key: 'payRunId', value: payRunId },
          { key: 'state', value: state || 'unknown' },
        ],
        extra: {
          payRunId,
          ...(failingEmployee ? { employeeId: failingEmployee.id } : {}),
        },
        level: 'error',
        platform: 'node',
        firstSeen: '',
        lastSeen: new Date().toISOString(),
        count: '',
        shortId: '',
        project: 'event-driven-devin',
        release: process.env.SENTRY_RELEASE || 'customer-a7fb8819-payroll@1.0.0',
        environment: process.env.DD_ENV || 'prod',
        triggeredRule: '',
      });
      const session = outcome && outcome.session;
      if (issue && session) {
        const stateUpdated = await updateLinearIssueState({
          issueId: issue.id,
          stateId: LINEAR_STATE_IN_PROGRESS_ID,
        })
          .then(() => true)
          .catch((err) => {
            logger.warn('Failed to move Linear issue to In Progress', {
              error: err.message,
              identifier: issue.identifier,
              payRunId,
            });
            return false;
          });
        const commented = await addLinearComment({
          issueId: issue.id,
          body: [
            `Devin picked this up: ${session.url}`,
            '',
            'Moving to **In Progress**. The PR link will be posted here and the ticket moved to **In Review** once the fix is ready.',
          ].join('\n'),
        })
          .then(() => true)
          .catch((err) => {
            logger.warn('Failed to comment Devin session on Linear issue', {
              error: err.message,
              identifier: issue.identifier,
              payRunId,
            });
            return false;
          });
        logger.info('Linear issue linked to Devin session', {
          identifier: issue.identifier,
          sessionId: session.sessionId,
          payRunId,
          stateUpdated,
          commented,
        });
      }
    })().catch((err) => logger.warn('Rippling payroll incident follow-up failed', { error: err.message, payRunId }));

    throw error;
  }
}

module.exports = {
  submitPayRun,
  PAY_RUN,
  EMPLOYEES,
  getPayRunEmployees,
  STATE_WITHHOLDING_POLICIES,
  REMEDIATION_DIRECTIVE,
  buildRemediationDirective,
  LINEAR_STATE_IN_PROGRESS_ID,
  LINEAR_STATE_IN_REVIEW_ID,
};
