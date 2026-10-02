const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLUG = '09bd61b4';
const SERVICE = 'customer-09bd61b4-ach-approvals';
const VERTICAL_LABEL = 'Bank of America CashPro — ACH & Wire Approvals';
const ROUTE = '/api/09bd61b4/payments/:id/approve';

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Bank of America CashPro ACH and wire approval workflow:',
  '- Service: `app/services/verticals/09bd61b4.js`',
  '- Route: `app/routes/verticals/09bd61b4.js`',
  '- Page: `app/public/verticals/09bd61b4.html` (served at `/09bd61b4` and `/bofa`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function createSeedPayments() {
  return [
    {
      id: 'ACH-2026-000123',
      reference: 'ACH-2026-000123',
      type: 'ACH',
      secCode: 'CCD',
      receiverName: 'Northwest Medical Supply',
      receiverRoutingNumber: '021000021',
      receiverAccountMasked: '•••• 1287',
      amount: 1850.75,
      currency: 'USD',
      effectiveDate: '2026-10-05',
      originatorAccount: 'Becker Industries Operating ••••2217',
      createdBy: 'KWilliams',
      createdAt: minutesAgo(4),
      status: 'PENDING_APPROVAL',
    },
    {
      id: 'ACH-2026-000124',
      reference: 'ACH-2026-000124',
      type: 'ACH',
      secCode: 'PPD',
      receiverName: 'Harbor Freight Lines',
      receiverRoutingNumber: '021000021',
      receiverAccountMasked: '•••• 4431',
      amount: 4680.25,
      currency: 'USD',
      effectiveDate: '2026-10-05',
      originatorAccount: 'Becker Industries Operating ••••2217',
      createdBy: 'DWalker',
      createdAt: minutesAgo(12),
      status: 'PENDING_APPROVAL',
    },
    {
      id: 'ACH-2026-000125',
      reference: 'ACH-2026-000125',
      type: 'ACH',
      secCode: 'CCD',
      receiverName: 'Lakeshore Utilities',
      receiverRoutingNumber: '011000015',
      receiverAccountMasked: '•••• 7930',
      amount: 275000,
      currency: 'USD',
      effectiveDate: '2026-10-06',
      originatorAccount: 'Becker Industries Operating ••••2217',
      createdBy: 'KWilliams',
      createdAt: minutesAgo(21),
      status: 'PENDING_APPROVAL',
    },
    {
      id: 'ACH-2026-000126',
      reference: 'ACH-2026-000126',
      type: 'ACH',
      secCode: 'PPD',
      receiverName: 'Easton Office Products',
      receiverRoutingNumber: '021000021',
      receiverAccountMasked: '•••• 2406',
      amount: 3220.44,
      currency: 'USD',
      effectiveDate: '2026-10-06',
      originatorAccount: 'Becker Industries Operating ••••2217',
      createdBy: 'DWalker',
      createdAt: minutesAgo(35),
      status: 'PENDING_APPROVAL',
    },
    {
      id: 'ACH-2026-000127',
      reference: 'ACH-2026-000127',
      type: 'ACH',
      secCode: 'CCD',
      receiverName: 'Becker Regional Clinic',
      receiverRoutingNumber: '011000015',
      receiverAccountMasked: '•••• 9018',
      amount: 12480.12,
      currency: 'USD',
      effectiveDate: '2026-10-07',
      originatorAccount: 'Becker Industries Operating ••••2217',
      createdBy: 'KWilliams',
      createdAt: minutesAgo(48),
      status: 'PENDING_APPROVAL',
    },
    {
      id: 'WIR-2026-000045',
      reference: 'WIR-2026-000045',
      type: 'WIRE',
      secCode: null,
      receiverName: 'Harbor Freight Lines',
      receiverRoutingNumber: '026009593',
      receiverAccountMasked: '•••• 7725',
      amount: 64000,
      currency: 'USD',
      effectiveDate: '2026-10-05',
      originatorAccount: 'Becker Industries Operating ••••2217',
      createdBy: 'DWalker',
      createdAt: minutesAgo(64),
      status: 'PENDING_APPROVAL',
    },
  ];
}

let payments = createSeedPayments();

function listPendingApprovals() {
  if (!payments.some((payment) => payment.status === 'PENDING_APPROVAL')) {
    payments = createSeedPayments();
  }
  return payments
    .filter((payment) => payment.status === 'PENDING_APPROVAL')
    .map((payment) => ({ ...payment }));
}

function requestError(statusCode, code, message) {
  const error = new Error(message);
  error.name = statusCode === 400 ? 'ValidationError' : statusCode === 404 ? 'NotFoundError' : 'ConflictError';
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function recordApproval(payment, approval) {
  payment.status = 'APPROVED';
  payment.approvedBy = approval.approverId;
  payment.approvedAt = approval.approvedAt || new Date().toISOString();
  return payment;
}

function buildApprovalEvent(payment, approval) {
  return {
    schemaVersion: 2,
    eventType: 'payment.approved',
    eventId: uuidv4(),
    occurredAt: new Date().toISOString(),
    payment: {
      id: payment.id,
      reference: payment.reference,
      type: payment.type,
      instruction: {
        amount: {
          value: payment.amount,
          currency: payment.currency,
        },
        effectiveDate: payment.effectiveDate,
        receiver: {
          name: payment.receiverName,
          routingNumber: payment.receiverRoutingNumber,
          account: payment.receiverAccountMasked,
        },
      },
      originator: {
        company: 'Becker Industries',
        account: payment.originatorAccount,
      },
    },
    approval: {
      approverId: approval.approverId,
      method: 'SECURID',
      approvedAt: approval.approvedAt,
    },
  };
}

function toSubmissionRequest(event) {
  return {
    paymentId: event.paymentId,
    amount: event.instruction.amount,
    routingNumber: event.instruction.receiver.routingNumber,
  };
}

const achSubmissionWorker = {
  enqueue(event) {
    return toSubmissionRequest(event);
  },
};

function reportSubmissionFailure(error, payment, request, requestId, startTime) {
  const duration = Date.now() - startTime;

  Sentry.captureException(error, {
    tags: {
      service: SERVICE,
      route: ROUTE,
      paymentType: payment.type,
      approverId: request.approverId,
    },
    extra: {
      paymentId: payment.id,
      reference: payment.reference,
      requestId,
      approverId: request.approverId,
    },
  });

  incrementMetric('ach.payment.submission.failure', {
    route: ROUTE,
    errorClass: error.name,
    paymentType: payment.type,
  });
  recordTiming('ach.payment.approval.latency', duration, {
    route: ROUTE,
    error: 'true',
  });
  logger.error('CashPro payment submission failed', {
    paymentId: payment.id,
    reference: payment.reference,
    approverId: request.approverId,
    requestId,
    error: error.message,
    errorClass: error.name,
    durationMs: duration,
    service: SERVICE,
  });

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/09bd61b4.js — ACH approval submission',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: request.devinUserId,
    devinEmail: request.devinEmail,
    devinOrgId: request.devinOrgId,
    service: SERVICE,
    verticalLabel: VERTICAL_LABEL,
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: SLUG,
    slackMemberId: 'U0BQZBHCNMA',
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'paymentType', value: payment.type },
      { key: 'paymentReference', value: payment.reference },
    ],
    extra: {
      paymentId: payment.id,
      reference: payment.reference,
      approverId: request.approverId,
      requestId,
    },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
  }).catch((alertError) => {
    logger.error('Failed to post alert for CashPro approval error', {
      paymentId: payment.id,
      requestId,
      error: alertError.message,
    });
  });

  return {
    statusCode: 500,
    body: {
      success: false,
      error: error.message,
      errorClass: error.name || 'Error',
      code: 'SUBMISSION_FAILED',
      paymentId: payment.id,
      paymentStatus: payment.status,
      requestId,
    },
  };
}

function approvePayment(paymentId, request, requestId) {
  const startTime = Date.now();
  if (typeof request.securIdToken !== 'string' || !/^\d{6,8}$/.test(request.securIdToken)) {
    throw requestError(400, 'INVALID_SECURID_TOKEN', 'SecurID token must contain 6 to 8 digits');
  }

  const payment = payments.find((candidate) => candidate.id === paymentId);
  if (!payment) {
    throw requestError(404, 'PAYMENT_NOT_FOUND', 'Payment was not found');
  }
  if (typeof request.approverId !== 'string' || request.approverId.trim() === '') {
    throw requestError(400, 'APPROVER_REQUIRED', 'Approver ID is required');
  }
  if (payment.status !== 'PENDING_APPROVAL' || request.approverId === payment.createdBy) {
    throw requestError(409, 'APPROVAL_CONFLICT', 'Payment cannot be approved by this user in its current state');
  }

  const approval = {
    approverId: request.approverId,
    approvedAt: new Date().toISOString(),
  };
  recordApproval(payment, approval);
  const event = buildApprovalEvent(payment, approval);

  try {
    const submission = achSubmissionWorker.enqueue(event);
    payment.status = 'SUBMITTED';
    return {
      statusCode: 200,
      body: {
        success: true,
        paymentId: payment.id,
        paymentStatus: payment.status,
        submission,
      },
    };
  } catch (error) {
    return reportSubmissionFailure(error, payment, request, requestId, startTime);
  }
}

module.exports = {
  listPendingApprovals,
  approvePayment,
  recordApproval,
  buildApprovalEvent,
  achSubmissionWorker,
  toSubmissionRequest,
};
