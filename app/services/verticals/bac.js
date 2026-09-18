const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'bac-banca-en-linea';
const ROUTE = '/api/bac/transferencia';
const PAGE = '/bac';

/**
 * On-call routing for this vertical is driven by the demo identity captured on
 * the page (a devindemos.com address), which `resolveOnCallMember()` looks up
 * in Slack. This fallback only applies when that lookup finds nobody.
 */
const SLACK_MEMBER_ID_FALLBACK = process.env.BAC_SLACK_MEMBER_ID || '';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the BAC Credomatic Banca en Línea transfer vertical:',
  `- Service: \`app/services/verticals/bac.js\``,
  `- Route: \`app/routes/verticals/bac.js\``,
  `- Page: \`app/public/verticals/bac.html\` (served at \`${PAGE}\`)`,
  '',
  'Start from the transfer that failed and work back to the commission schedule',
  'the debit account is enrolled in — the crash site is downstream of the shape',
  'the fee resolver returns, not the cause of it.',
  '',
  'Open a pull request against `main` with the fix, and verify it end-to-end on',
  `the \`${PAGE}\` page.`,
].join('\n');

/**
 * Cuentas shown on the Banca en Línea dashboard.
 */
const ACCOUNTS = [
  {
    id: 'CR-901-4417',
    name: 'Cuenta de Ahorros',
    product: 'Ahorro Preferente',
    tier: 'premium',
    balance: 18420.35,
    currency: 'USD',
  },
  {
    id: 'CR-901-2205',
    name: 'Cuenta Corriente',
    product: 'Corriente Clásica',
    tier: 'clasica',
    balance: 6240.8,
    currency: 'USD',
  },
  {
    id: 'CR-901-8830',
    name: 'Cuenta Planilla',
    product: 'Planilla Oro',
    tier: 'oro',
    balance: 3105.12,
    currency: 'USD',
  },
];

/**
 * Movimientos recientes for display.
 */
const TRANSACTIONS = [
  {
    id: 'MOV-001', date: '2026-03-15', description: 'Acreditación de planilla', amount: 2480.0, type: 'credit', account: 'CR-901-4417',
  },
  {
    id: 'MOV-002', date: '2026-03-14', description: 'Compañía Nacional de Fuerza y Luz', amount: -63.4, type: 'debit', account: 'CR-901-4417',
  },
  {
    id: 'MOV-003', date: '2026-03-13', description: 'Automercado San Pedro', amount: -112.85, type: 'debit', account: 'CR-901-4417',
  },
  {
    id: 'MOV-004', date: '2026-03-12', description: 'Transferencia a Cuenta Corriente', amount: -400.0, type: 'transfer', account: 'CR-901-4417',
  },
  {
    id: 'MOV-005', date: '2026-03-11', description: 'Pago tarjeta Credomatic', amount: -289.99, type: 'debit', account: 'CR-901-2205',
  },
];

/**
 * Comisiones por transferencia según el tipo de cuenta.
 */
const FEE_TIERS = {
  premium: { rate: 0, flat: 0 },
  oro: { rate: 0.001, flat: 1.5 },
  clasica: { rate: 0.002, flat: 3.25 },
};

/**
 * Resolve the commission schedule for a given account tier.
 */
async function resolveFeeTier(accountTier) {
  const tier = FEE_TIERS[accountTier];
  if (!tier) return null;
  return { params: [tier.rate, tier.flat] };
}

/**
 * Calculate the transfer commission from the resolved tier data.
 */
function calculateTransferFee(tierData, amount) {
  const baseFee = tierData.schedule.rate * amount;
  const minimumFee = tierData.schedule.flat;
  return Math.max(baseFee, minimumFee);
}

/**
 * Format the comprobante returned to the browser.
 */
function formatReceipt(transfer, feeBreakdown) {
  return {
    receiptId: `BAC-${Date.now()}`,
    from: transfer.fromAccount,
    to: transfer.toAccount,
    amount: Number(transfer.amount).toFixed(2),
    fee: feeBreakdown.fee.toFixed(2),
    totalDebit: feeBreakdown.totalDebit.toFixed(2),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process a transfer between BAC accounts.
 */
async function processTransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();
  const accountTier = data.accountTier || 'premium';

  logger.info('Processing BAC transfer', {
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

    const tierData = resolveFeeTier(accountTier);
    const fee = calculateTransferFee(tierData, Number(data.amount));
    const totalDebit = Number(data.amount) + fee;
    const receipt = formatReceipt(data, { fee, totalDebit });

    const duration = Date.now() - startTime;

    incrementMetric('bac_transfer.success', { route: ROUTE, accountTier });
    recordTiming('bac_transfer.latency', duration, { route: ROUTE });

    logger.info('BAC transfer completed', {
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

    incrementMetric('bac_transfer.failure', { route: ROUTE, errorClass: error.name, accountTier });
    recordTiming('bac_transfer.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('BAC transfer failed', {
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
      culprit: 'app/services/verticals/bac.js \u2014 processTransfer',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'BAC Credomatic Banca en L\u00ednea \u2014 Transferencia',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'bac',
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
      logger.error('Failed to trigger Devin session from BAC transfer error', {
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
  FEE_TIERS,
  REMEDIATION_DIRECTIVE,
};
