const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.C1D7F8961_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Funding accounts the payroll cycle can be debited from.
 */
const FUNDING_ACCOUNTS = {
  'ACCT-1001': { id: 'ACCT-1001', label: 'Corporate operating account', iban: 'SA** 1001' },
  'ACCT-1002': { id: 'ACCT-1002', label: 'Payroll reserve account', iban: 'SA** 1002' },
};

/**
 * Wage Protection System file layouts, keyed by payroll run type. Each run type
 * files a differently shaped salary file with the protection system.
 *
 * NOTE: off-cycle bonus runs were enabled for business customers in the
 * September cycle; their layout was expected to be registered alongside them.
 */
const WPS_FILE_FORMATS = {
  'monthly-salary': {
    fileFormat: 'WPS-SIF-2.1',
    establishmentRecord: 'EDR',
    salaryRecord: 'SDR',
    settlementDays: 0,
  },
  'mid-month-adjustment': {
    fileFormat: 'WPS-SIF-2.1-ADJ',
    establishmentRecord: 'EDR',
    salaryRecord: 'ADR',
    settlementDays: 1,
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
  'The failing code path is the business-center payroll disbursement vertical:',
  '- Service: `app/services/verticals/1d7f8961.js`',
  '- Route: `app/routes/verticals/1d7f8961.js`',
  '- Page: `app/public/verticals/1d7f8961.html` (served at `/1d7f8961`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Build the Wage Protection System salary file attached to a disbursement:
 * the layout the run type files under, and the per-employee record count.
 */
function buildWpsSalaryFile(runType, employeeCount) {
  const layout = WPS_FILE_FORMATS[runType];

  return {
    runType,
    fileFormat: layout.fileFormat,
    establishmentRecord: layout.establishmentRecord,
    salaryRecords: employeeCount,
    salaryRecordType: layout.salaryRecord,
    settlementDays: layout.settlementDays,
  };
}

/**
 * Release an approved payroll cycle to employee accounts.
 */
async function releaseDisbursement(data) {
  const startTime = Date.now();
  const disbursementId = uuidv4();
  const fundingAccount = FUNDING_ACCOUNTS[data.fromAccount];
  const amount = Number(data.amount);
  const employeeCount = Number(data.employeeCount) || 1248;
  const runType = data.runType || 'monthly-salary';

  logger.info('Releasing payroll disbursement', {
    disbursementId,
    runType,
    employeeCount,
    service: 'customer-1d7f8961-payroll',
    route: '/api/1d7f8961/disbursement',
  });

  if (!fundingAccount) {
    const error = new Error(`Unknown funding account: ${data.fromAccount || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'FUNDING_ACCOUNT_NOT_FOUND';
    throw error;
  }

  if (!isFinite(amount) || amount <= 0) {
    const error = new Error('Payroll amount must be greater than zero');
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'INVALID_PAYROLL_AMOUNT';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const wpsFile = buildWpsSalaryFile(runType, employeeCount);

    incrementMetric('payroll_disbursement.released', {
      route: '/api/1d7f8961/disbursement',
      runType,
    });
    recordTiming('payroll_disbursement.latency', Date.now() - startTime, {
      route: '/api/1d7f8961/disbursement',
      error: 'false',
    });

    logger.info('Payroll disbursement released', {
      disbursementId,
      runType,
      amount,
      employeeCount,
    });

    return {
      success: true,
      disbursementId,
      status: 'released',
      reference: `WPS-${disbursementId.replace(/-/g, '').slice(0, 10).toUpperCase()}`,
      fundingAccount: `${fundingAccount.label} \u2014 ${fundingAccount.iban}`,
      amount,
      employeeCount,
      wpsFile,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('payroll_disbursement.failure', {
      route: '/api/1d7f8961/disbursement',
      errorClass: error.name,
      runType,
    });
    recordTiming('payroll_disbursement.latency', duration, {
      route: '/api/1d7f8961/disbursement',
      error: 'true',
    });

    logger.error('Payroll disbursement failed', {
      disbursementId,
      runType,
      amount,
      employeeCount,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-1d7f8961-payroll',
    });

    Sentry.captureException(error, {
      tags: {
        service: 'customer-1d7f8961-payroll',
        route: '/api/1d7f8961/disbursement',
        runType,
      },
      extra: { disbursementId, amount, employeeCount },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/1d7f8961.js \u2014 buildWpsSalaryFile',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: 'customer-1d7f8961-payroll',
      verticalLabel: 'Payroll Disbursement',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '1d7f8961',
      tags: [
        { key: 'route', value: '/api/1d7f8961/disbursement' },
        { key: 'service', value: 'customer-1d7f8961-payroll' },
        { key: 'runType', value: runType },
      ],
      extra: {
        disbursementId,
        amount,
        employeeCount,
        runType,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for payroll disbursement error', {
        disbursementId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  releaseDisbursement,
  FUNDING_ACCOUNTS,
  WPS_FILE_FORMATS,
};
