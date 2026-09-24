const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'banamex-banca-en-linea';
const ROUTE = '/api/banamex/traspaso';
const PAGE = '/banamex';

/**
 * On-call routing for this vertical is driven by the demo identity captured on
 * the page (a devindemos.com address), which `resolveOnCallMember()` looks up
 * in Slack. This fallback only applies when that lookup finds nobody.
 */
const SLACK_MEMBER_ID_FALLBACK = process.env.BANAMEX_SLACK_MEMBER_ID || '';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Banamex Banca en Línea traspaso vertical:',
  '- Service: `app/services/verticals/banamex.js`',
  '- Route: `app/routes/verticals/banamex.js`',
  `- Page: \`app/public/verticals/banamex.html\` (served at \`${PAGE}\`)`,
  '',
  'Start from the traspaso that failed and work back to the commission schedule',
  'the debit account is enrolled in — the crash site is downstream of what the',
  'fee resolver returns, not the cause of it.',
  '',
  'Open a pull request against `main` with the fix, and verify it end-to-end on',
  `the \`${PAGE}\` page.`,
].join('\n');

/**
 * Cuentas shown on the Banca en Línea dashboard.
 */
const ACCOUNTS = [
  {
    id: 'BMX-5729814',
    name: 'Cuenta Perfiles',
    product: 'Perfiles Banamex',
    tier: 'prioritario',
    balance: 48320.55,
    currency: 'MXN',
  },
  {
    id: 'BMX-5731042',
    name: 'Ahorro Banamex',
    product: 'Ahorro Garantizado',
    tier: 'clasica',
    balance: 112940.18,
    currency: 'MXN',
  },
  {
    id: 'BMX-4071',
    name: 'Tarjeta Oro Banamex',
    product: 'Crédito Oro',
    tier: 'oro',
    balance: 23415.7,
    currency: 'MXN',
  },
];

/**
 * Movimientos recientes for display.
 */
const TRANSACTIONS = [
  {
    id: 'MOV-001', date: '2026-03-16', description: 'Depósito de nómina', amount: 28450.0, type: 'credit', account: 'BMX-5729814',
  },
  {
    id: 'MOV-002', date: '2026-03-15', description: 'CFE — Suministro básico', amount: -1284.5, type: 'debit', account: 'BMX-5729814',
  },
  {
    id: 'MOV-003', date: '2026-03-14', description: 'Telcel Plan Max', amount: -749.0, type: 'debit', account: 'BMX-5729814',
  },
  {
    id: 'MOV-004', date: '2026-03-13', description: 'SPEI enviado — BBVA ••4921', amount: -6500.0, type: 'transfer', account: 'BMX-5729814',
  },
  {
    id: 'MOV-005', date: '2026-03-12', description: 'Pago Tarjeta Oro Banamex', amount: -3200.0, type: 'debit', account: 'BMX-5729814',
  },
];

/**
 * Comisiones por traspaso según el tipo de cuenta.
 */
const COMMISSION_SCHEDULES = {
  prioritario: { rate: 0, flat: 0 },
  clasica: { rate: 0.0015, flat: 12 },
  oro: { rate: 0.001, flat: 8 },
};

/**
 * Resolve the commission schedule the debit account is enrolled in.
 *
 * An unenrolled tier is a configuration defect, so it fails here with the tier
 * in the message rather than surfacing as an undefined schedule downstream.
 */
function resolveCommissionSchedule(accountTier) {
  if (!Object.prototype.hasOwnProperty.call(COMMISSION_SCHEDULES, accountTier)) {
    const error = new Error(`No commission schedule is configured for account tier "${accountTier}"`);
    error.name = 'CommissionScheduleError';
    error.code = 'COMMISSION_SCHEDULE_NOT_FOUND';
    error.accountTier = accountTier;
    throw error;
  }

  return COMMISSION_SCHEDULES[accountTier];
}

/**
 * Calculate the traspaso commission from the resolved schedule.
 */
function calculateTransferFee(schedule, amount) {
  const baseFee = schedule.rate * amount;
  return Math.max(baseFee, schedule.flat);
}

/**
 * Format the comprobante returned to the browser.
 */
function formatReceipt(transfer, feeBreakdown, transferId) {
  return {
    receiptId: `BMX-${transferId}`,
    from: transfer.fromAccount,
    to: transfer.toAccount,
    amount: Number(transfer.amount).toFixed(2),
    fee: feeBreakdown.fee.toFixed(2),
    totalDebit: feeBreakdown.totalDebit.toFixed(2),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process a traspaso between Banamex accounts.
 */
async function processTransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();
  const accountTier = data.accountTier || 'prioritario';

  logger.info('Processing Banamex traspaso', {
    transferId,
    fromAccount: data.fromAccount,
    toAccount: data.toAccount,
    amount: data.amount,
    accountTier,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const schedule = resolveCommissionSchedule(accountTier);
    const fee = calculateTransferFee(schedule, Number(data.amount));
    const totalDebit = Number(data.amount) + fee;
    const receipt = formatReceipt(data, { fee, totalDebit }, transferId);

    const duration = Date.now() - startTime;

    incrementMetric('banamex_transfer.success', { route: ROUTE, accountTier });
    recordTiming('banamex_transfer.latency', duration, { route: ROUTE });

    logger.info('Banamex traspaso completed', {
      transferId,
      receiptId: receipt.receiptId,
      durationMs: duration,
      service: SERVICE,
    });

    return {
      success: true,
      transferId,
      receipt,
      status: 'completed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('banamex_transfer.failure', { route: ROUTE, errorClass: error.name, accountTier });
    recordTiming('banamex_transfer.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Banamex traspaso failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      toAccount: data.toAccount,
      accountTier,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, accountTier, page: PAGE, alert_path: 'instant',
      },
      extra: {
        transferId,
        fromAccount: data.fromAccount,
        toAccount: data.toAccount,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/banamex.js \u2014 processTransfer',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Banamex Banca en L\u00ednea \u2014 Traspaso',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'banamex',
      slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'accountTier', value: accountTier },
        { key: 'page', value: PAGE },
      ],
      extra: {
        transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount,
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
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from Banamex traspaso error', {
        transferId,
        error: alertError.message,
      });
    });

    error.transferId = transferId;
    throw error;
  }
}

module.exports = {
  processTransfer,
  ACCOUNTS,
  TRANSACTIONS,
  COMMISSION_SCHEDULES,
  REMEDIATION_DIRECTIVE,
};
