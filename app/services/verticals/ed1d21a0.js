const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.EVERCORE_SLACK_MEMBER_ID || 'U0B7F46NVA4';

const SERVICE = 'customer-ed1d21a0-wire-instructions';
const ROUTE = '/api/ed1d21a0/invoices/:invoiceId/wire';

const CLIENT = {
  id: 'cli_halden',
  name: 'Halden Capital Partners',
  tenant: 'Financial Sponsors',
  user: { name: 'Priya Shah', title: 'CFO, Halden Capital Partners', initials: 'PS' },
  coverage: { banker: 'Daniel Okafor', title: 'Senior Managing Director' },
};

const DEALS = [
  { id: 'dl_cobalt', name: 'Project Cobalt', type: 'Sell-side M&A', status: 'Active', counterparty: 'Undisclosed strategic', ev: '$1.2B' },
  { id: 'dl_meridian', name: 'Project Meridian', type: 'Debt advisory', status: 'Signed', counterparty: 'Unitranche lender group', ev: '$450M' },
  { id: 'dl_larch', name: 'Project Larch', type: 'Buy-side M&A', status: 'Closed', counterparty: 'Larch Packaging Co.', ev: '$680M' },
];

/**
 * Remit-to accounts. Records synced from the SharePoint deal-management list
 * still carry the legacy `bank_ref` shape; records created in the portal use
 * the structured `beneficiaryBank` shape.
 */
const REMIT_ACCOUNTS = {
  rem_ny_ops: {
    source: 'portal',
    beneficiary: 'Evercore Group L.L.C.',
    beneficiaryBank: { name: 'JPMorgan Chase Bank, N.A.', aba: '021000021', swift: 'CHASUS33', city: 'New York, NY' },
    account: '000771204821',
  },
  rem_ny_retainer: {
    source: 'sharepoint-sync',
    beneficiary: 'Evercore Group L.L.C.',
    bank_ref: { bank_name: 'Bank of New York Mellon', routing: '021000018', bic: 'IRVTUS3N', branch: 'New York, NY' },
    account: '000890336107',
  },
};

const INVOICES = [
  { id: 'INV-2026-0642', dealId: 'dl_cobalt', description: 'Monthly retainer — September 2026', amount: 150000, issued: '2026-09-01', due: '2026-10-01', status: 'Due', remitTo: 'rem_ny_retainer' },
  { id: 'INV-2026-0611', dealId: 'dl_cobalt', description: 'Expense reimbursement — data room, travel', amount: 38412.55, issued: '2026-09-03', due: '2026-10-03', status: 'Open', remitTo: 'rem_ny_ops' },
  { id: 'INV-2026-0587', dealId: 'dl_meridian', description: 'Financing fee — signing milestone', amount: 1125000, issued: '2026-08-14', due: '2026-09-13', status: 'Paid', remitTo: 'rem_ny_ops' },
  { id: 'INV-2026-0433', dealId: 'dl_larch', description: 'Success fee — transaction close', amount: 6800000, issued: '2026-06-02', due: '2026-07-02', status: 'Paid', remitTo: 'rem_ny_ops' },
];

const DEMO_MFA_CODE = '482913';

function getPortal() {
  return {
    client: CLIENT,
    deals: DEALS,
    invoices: INVOICES.map((inv) => {
      const deal = DEALS.find((d) => d.id === inv.dealId);
      return { ...inv, dealName: deal.name, remitTo: undefined };
    }),
    mfa: { method: 'Authenticator app', hint: DEMO_MFA_CODE },
  };
}

function clientError(message, code, statusCode) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Normalise a remit-to record into the portal's canonical shape.
 */
function normalizeRemitTo(record) {
  return {
    source: record.source,
    beneficiary: record.beneficiary,
    account: record.account,
    beneficiaryBank: record.beneficiaryBank,
  };
}

function maskAccount(account) {
  return `\u2022\u2022\u2022\u2022 ${String(account).slice(-4)}`;
}

/**
 * Build the wire-instruction card shown to the client after step-up MFA.
 */
function formatWireInstructions(invoice, remit) {
  return {
    invoiceId: invoice.id,
    amount: invoice.amount,
    currency: 'USD',
    beneficiary: remit.beneficiary,
    bank: remit.beneficiaryBank.name,
    aba: remit.beneficiaryBank.aba,
    swift: remit.beneficiaryBank.swift,
    bankCity: remit.beneficiaryBank.city,
    account: remit.account,
    accountMasked: maskAccount(remit.account),
    reference: `${invoice.id} / ${CLIENT.name}`,
  };
}

async function revealWireInstructions(data) {
  const startTime = Date.now();
  const requestId = `req_${uuidv4().slice(0, 8)}`;

  logger.info('Wire instructions requested', {
    requestId, invoiceId: data.invoiceId, clientId: CLIENT.id, service: SERVICE, route: ROUTE,
  });

  const invoice = INVOICES.find((i) => i.id === data.invoiceId);
  if (!invoice) throw clientError('Invoice not found.', 'INVOICE_NOT_FOUND', 404);
  if (String(data.mfaCode || '').trim() !== DEMO_MFA_CODE) {
    throw clientError('That code didn\u2019t match. Check your authenticator app and try again.', 'MFA_INVALID', 401);
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 900 + Math.random() * 500));

    const remit = normalizeRemitTo(REMIT_ACCOUNTS[invoice.remitTo]);
    const wire = formatWireInstructions(invoice, remit);

    const duration = Date.now() - startTime;
    incrementMetric('wire_instructions.success', { route: ROUTE });
    recordTiming('wire_instructions.latency', duration, { route: ROUTE });
    logger.info('Wire instructions revealed', {
      requestId, invoiceId: invoice.id, clientId: CLIENT.id, account: wire.accountMasked,
    });

    return { success: true, requestId, wire, audit: { event: 'wire.revealed', at: new Date().toISOString() } };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('wire_instructions.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('wire_instructions.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Wire instructions failed', {
      requestId, invoiceId: invoice.id, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, invoice: invoice.id, alert_path: 'instant' },
      extra: { requestId, clientId: CLIENT.id, remitTo: invoice.remitTo },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ed1d21a0.js \u2014 formatWireInstructions',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Evercore Client Portal \u2014 View wire instructions',
      customer: 'ed1d21a0',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'invoice', value: invoice.id },
      ],
      extra: { requestId, clientId: CLIENT.id, remitTo: invoice.remitTo },
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
      logger.error('Failed to create Devin session for wire instructions error', { error: err.message, requestId });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  getPortal,
  revealWireInstructions,
  INVOICES,
};
