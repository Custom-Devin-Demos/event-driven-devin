const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  CLAIM_STATUS,
  MEMBER_TYPE,
  POSITION_STATUS,
  SERVICE_TYPE,
  BENEFIT_CATEGORY,
} = require('./95d1a7d1-codes');

const SERVICE = 'customer-95d1a7d1-claims-inquiry';
const ROUTE = '/api/95d1a7d1/inquiry';
const SLACK_MEMBER_ID = process.env.HCPS_SLACK_MEMBER_ID || 'U09MEGVGG2Z';

const CLAIM_ID_PATTERN = /^CLM\d{7}$/;
const USER_ID_PATTERN = /^[A-Z0-9]{1,8}$/;

/**
 * Claim master records (CLMFILE). Field order follows the CLAIMREC copybook;
 * amounts are the COMP-3 totals carried on the record.
 */
const CLAIM_MASTER = [
  {
    claimId: 'CLM0000101',
    memberId: 'MBR0048213',
    memberName: 'HARRIET OKONKWO',
    memberType: 'I',
    providerId: 'PRV0001177',
    providerName: 'RIVERSIDE FAMILY MEDICINE',
    serviceDate: '2026-08-14',
    createDate: '2026-08-15',
    lastMaint: '2026-08-29',
    status: 'C',
    diagnosisCode: 'J06.9',
    procedureCode: '99213',
    serviceType: 'MED',
    currency: 'USD',
  },
  {
    claimId: 'CLM0000238',
    memberId: 'MBR0071902',
    memberName: 'DESMOND ALVAREZ',
    memberType: 'F',
    providerId: 'PRV0002460',
    providerName: 'LAKESHORE DENTAL GROUP',
    serviceDate: '2026-09-02',
    createDate: '2026-09-03',
    lastMaint: '2026-09-10',
    status: 'A',
    diagnosisCode: 'K02.51',
    procedureCode: 'D2392',
    serviceType: 'DEN',
    currency: 'USD',
  },
  {
    claimId: 'CLM0000305',
    memberId: 'MBR0033571',
    memberName: 'PRIYA RAGHUNATHAN',
    memberType: 'I',
    providerId: 'PRV0003318',
    providerName: 'CENTRAL AVE PHARMACY',
    serviceDate: '2026-09-11',
    createDate: '2026-09-11',
    lastMaint: '2026-09-12',
    status: 'C',
    diagnosisCode: 'E11.9',
    procedureCode: 'J1815',
    serviceType: 'PHR',
    currency: 'USD',
  },
  {
    claimId: 'CLM0000417',
    memberId: 'MBR0056048',
    memberName: 'MARCUS ELLINGTON',
    memberType: 'G',
    providerId: 'PRV0004092',
    providerName: 'NORTHGATE BEHAVIORAL HEALTH',
    serviceDate: '2026-09-18',
    createDate: '2026-09-19',
    lastMaint: '2026-09-26',
    status: 'A',
    diagnosisCode: 'F41.1',
    procedureCode: '90837',
    serviceType: 'BHV',
    currency: 'USD',
  },
  {
    claimId: 'CLM0000512',
    memberId: 'MBR0019384',
    memberName: 'ANNELIESE BERGSTROM',
    memberType: 'I',
    providerId: 'PRV0005731',
    providerName: 'CLEARVIEW EYE ASSOCIATES',
    serviceDate: '2026-09-22',
    createDate: '2026-09-23',
    lastMaint: '2026-09-24',
    status: 'P',
    diagnosisCode: 'H52.13',
    procedureCode: '92014',
    serviceType: 'VIS',
    currency: 'USD',
  },
];

/**
 * Claim position records (POSFILE), keyed by claim id + date + service code.
 */
const CLAIM_POSITIONS = {
  CLM0000101: [
    { date: '2026-08-14', serviceCode: '99213', quantity: 1, charged: 215.0, allowed: 142.6, paid: 112.6, deductible: 0, copay: 30.0, coinsurance: 0, status: 'C', lastUpdate: '2026-08-29T21:14:07.113402' },
    { date: '2026-08-14', serviceCode: '87880', quantity: 1, charged: 48.0, allowed: 26.4, paid: 26.4, deductible: 0, copay: 0, coinsurance: 0, status: 'C', lastUpdate: '2026-08-29T21:14:07.220981' },
  ],
  CLM0000238: [
    { date: '2026-09-02', serviceCode: 'D2392', quantity: 1, charged: 310.0, allowed: 198.0, paid: 158.4, deductible: 0, copay: 0, coinsurance: 39.6, status: 'O', lastUpdate: '2026-09-10T03:02:41.550817' },
    { date: '2026-09-02', serviceCode: 'D0220', quantity: 2, charged: 64.0, allowed: 44.0, paid: 44.0, deductible: 0, copay: 0, coinsurance: 0, status: 'C', lastUpdate: '2026-09-10T03:02:41.671250' },
  ],
  CLM0000305: [
    { date: '2026-09-11', serviceCode: 'J1815', quantity: 3, charged: 412.5, allowed: 287.25, paid: 242.25, deductible: 0, copay: 45.0, coinsurance: 0, status: 'C', lastUpdate: '2026-09-12T02:47:19.004613' },
  ],
  CLM0000417: [
    { date: '2026-09-18', serviceCode: '90837', quantity: 1, charged: 260.0, allowed: 168.0, paid: 128.0, deductible: 0, copay: 40.0, coinsurance: 0, status: 'O', lastUpdate: '2026-09-26T01:39:52.812204' },
    { date: '2026-09-18', serviceCode: '90785', quantity: 1, charged: 55.0, allowed: 31.5, paid: 25.2, deductible: 0, copay: 0, coinsurance: 6.3, status: 'O', lastUpdate: '2026-09-26T01:39:52.930447' },
  ],
  CLM0000512: [
    { date: '2026-09-22', serviceCode: '92014', quantity: 1, charged: 185.0, allowed: 121.0, paid: 0, deductible: 0, copay: 0, coinsurance: 0, status: 'O', lastUpdate: '2026-09-24T22:05:33.177019' },
  ],
};

/**
 * Claim history rows (CLAIM_HISTORY), newest first by service date then time.
 */
const CLAIM_HISTORY = {
  CLM0000101: [
    { serviceDate: '2026-08-29', serviceTime: '21:14:07', claimType: 'PAY', charged: 263.0, allowed: 169.0, paid: 139.0 },
    { serviceDate: '2026-08-21', serviceTime: '09:32:15', claimType: 'ADJ', charged: 263.0, allowed: 169.0, paid: 0 },
    { serviceDate: '2026-08-15', serviceTime: '08:04:51', claimType: 'ORIG', charged: 263.0, allowed: 0, paid: 0 },
  ],
  CLM0000238: [
    { serviceDate: '2026-09-10', serviceTime: '03:02:41', claimType: 'PAY', charged: 374.0, allowed: 242.0, paid: 202.4 },
    { serviceDate: '2026-09-03', serviceTime: '07:45:00', claimType: 'ORIG', charged: 374.0, allowed: 0, paid: 0 },
  ],
  CLM0000305: [
    { serviceDate: '2026-09-12', serviceTime: '02:47:19', claimType: 'PAY', charged: 412.5, allowed: 287.25, paid: 242.25 },
    { serviceDate: '2026-09-11', serviceTime: '16:20:33', claimType: 'ORIG', charged: 412.5, allowed: 0, paid: 0 },
  ],
  CLM0000417: [
    { serviceDate: '2026-09-26', serviceTime: '01:39:52', claimType: 'ADJ', charged: 315.0, allowed: 199.5, paid: 153.2 },
    { serviceDate: '2026-09-19', serviceTime: '10:11:08', claimType: 'ORIG', charged: 315.0, allowed: 0, paid: 0 },
  ],
  CLM0000512: [
    { serviceDate: '2026-09-23', serviceTime: '14:58:26', claimType: 'ORIG', charged: 185.0, allowed: 0, paid: 0 },
  ],
};

/**
 * Plan-year accumulator schedules by benefit category. `outOfPocketMax` and
 * `deductible` are the individual limits; `coinsurancePct` is the member share
 * once the deductible is met.
 */
const BENEFIT_SCHEDULES = {
  medical: { deductible: 1500.0, outOfPocketMax: 4500.0, coinsurancePct: 20 },
  dental: { deductible: 50.0, outOfPocketMax: 1500.0, coinsurancePct: 20 },
  vision: { deductible: 0, outOfPocketMax: 400.0, coinsurancePct: 0 },
  pharmacy: { deductible: 250.0, outOfPocketMax: 2000.0, coinsurancePct: 25 },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the HCPS claims inquiry API that replaced the CICS CINQ transaction:',
  '- Service: `app/services/verticals/95d1a7d1.js`',
  '- Code tables: `app/services/verticals/95d1a7d1-codes.js`',
  '- Route: `app/routes/verticals/95d1a7d1.js`',
  '- Hosted UI: `app/public/verticals/95d1a7d1-app/` (served at `/95d1a7d1/app/`)',
  '- Regression coverage: `tests/95d1a7d1-claim-inquiry.test.js`',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.code = code;
  }
}

class NotFoundError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
    this.code = code;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeClaimId(raw) {
  const claimId = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!CLAIM_ID_PATTERN.test(claimId)) {
    throw new ValidationError('Claim ID must be CLM followed by 7 digits', 'INVALID_CLAIM_ID');
  }
  return claimId;
}

function normalizeUserId(raw) {
  const userId = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!USER_ID_PATTERN.test(userId)) {
    throw new ValidationError('User ID must be 1-8 alphanumeric characters', 'INVALID_USER_ID');
  }
  return userId;
}

function readClaimMaster(claimId) {
  const record = CLAIM_MASTER.find((claim) => claim.claimId === claimId);
  if (!record) {
    throw new NotFoundError(`Claim ${claimId} not found`, 'CLAIM_NOT_FOUND');
  }
  return record;
}

function readPositions(claimId) {
  return CLAIM_POSITIONS[claimId] || [];
}

function decodeClaim(record) {
  return {
    claimId: record.claimId,
    memberId: record.memberId,
    memberName: record.memberName,
    memberType: MEMBER_TYPE[record.memberType] || record.memberType,
    providerId: record.providerId,
    providerName: record.providerName,
    serviceDate: record.serviceDate,
    createDate: record.createDate,
    lastMaint: record.lastMaint,
    status: CLAIM_STATUS[record.status] || record.status,
    diagnosisCode: record.diagnosisCode,
    procedureCode: record.procedureCode,
    serviceType: SERVICE_TYPE[record.serviceType] || record.serviceType,
    currency: record.currency,
  };
}

function decodePositions(positions) {
  return positions.map((position) => ({
    date: position.date,
    serviceCode: position.serviceCode,
    quantity: position.quantity,
    charged: round2(position.charged),
    allowed: round2(position.allowed),
    paid: round2(position.paid),
    memberResponsibility: round2(position.deductible + position.copay + position.coinsurance),
    status: POSITION_STATUS[position.status] || position.status,
    lastUpdate: position.lastUpdate,
  }));
}

function resolveBenefitSchedule(record) {
  return BENEFIT_SCHEDULES[BENEFIT_CATEGORY[record.serviceType]];
}

function summarizeFinancials(record, positions) {
  const totals = positions.reduce((acc, position) => ({
    charged: acc.charged + position.charged,
    allowed: acc.allowed + position.allowed,
    paid: acc.paid + position.paid,
    deductible: acc.deductible + position.deductible,
    copay: acc.copay + position.copay,
    coinsurance: acc.coinsurance + position.coinsurance,
  }), { charged: 0, allowed: 0, paid: 0, deductible: 0, copay: 0, coinsurance: 0 });

  const memberResponsibility = totals.deductible + totals.copay + totals.coinsurance;
  const schedule = resolveBenefitSchedule(record);

  return {
    charged: round2(totals.charged),
    allowed: round2(totals.allowed),
    paid: round2(totals.paid),
    memberResponsibility: round2(memberResponsibility),
    deductible: round2(totals.deductible),
    copay: round2(totals.copay),
    coinsurance: round2(totals.coinsurance),
    deductibleRemaining: round2(Math.max(0, schedule.deductible - totals.deductible)),
    outOfPocketRemaining: round2(Math.max(0, schedule.outOfPocketMax - memberResponsibility)),
    currency: record.currency,
  };
}

function normalizePage(raw, fallback) {
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function paginate(rows, page, pageSize) {
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize);
  return { items, page, pageSize, hasMore: start + pageSize < rows.length, totalReturned: items.length };
}

function browsePositions(data) {
  const claimId = normalizeClaimId(data.claimId);
  const userId = normalizeUserId(data.userId || 'INQUSR01');
  readClaimMaster(claimId);
  const page = normalizePage(data.page, 1);
  const pageSize = normalizePage(data.pageSize, 10);
  logger.info('Claim inquiry audit', { claimId, userId, transaction: 'CINQ', program: 'INQPOS', service: SERVICE });
  incrementMetric('claim_inquiry.positions', { route: ROUTE });
  return paginate(decodePositions(readPositions(claimId)), page, pageSize);
}

function browseHistory(data) {
  const claimId = normalizeClaimId(data.claimId);
  const userId = normalizeUserId(data.userId || 'INQUSR01');
  readClaimMaster(claimId);
  const page = normalizePage(data.page, 1);
  const pageSize = normalizePage(data.pageSize, 15);
  const rows = [...(CLAIM_HISTORY[claimId] || [])].sort((a, b) => (
    b.serviceDate.localeCompare(a.serviceDate) || b.serviceTime.localeCompare(a.serviceTime)
  ));
  logger.info('Claim inquiry audit', { claimId, userId, transaction: 'CINQ', program: 'INQHIST', service: SERVICE });
  incrementMetric('claim_inquiry.history', { route: ROUTE });
  return paginate(rows.map((row) => ({
    serviceDate: row.serviceDate,
    serviceTime: row.serviceTime,
    claimType: row.claimType,
    charged: round2(row.charged),
    allowed: round2(row.allowed),
    paid: round2(row.paid),
  })), page, pageSize);
}

function listClaims() {
  return CLAIM_MASTER.map((record) => ({
    claimId: record.claimId,
    memberName: record.memberName,
    serviceType: SERVICE_TYPE[record.serviceType] || record.serviceType,
    status: CLAIM_STATUS[record.status] || record.status,
  }));
}

async function inquireClaim(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();
  const claimId = normalizeClaimId(data.claimId);
  const userId = normalizeUserId(data.userId || 'INQUSR01');

  logger.info('Processing claim inquiry', {
    inquiryId,
    claimId,
    userId,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));

    const record = readClaimMaster(claimId);
    const positions = readPositions(claimId);
    const claim = decodeClaim(record);
    const financial = summarizeFinancials(record, positions);
    const duration = Date.now() - startTime;

    logger.info('Claim inquiry audit', {
      inquiryId,
      claimId,
      userId,
      transaction: 'CINQ',
      program: 'INQCLM',
      service: SERVICE,
    });

    incrementMetric('claim_inquiry.success', { route: ROUTE, serviceType: record.serviceType });
    recordTiming('claim_inquiry.latency', duration, { route: ROUTE });

    return {
      success: true,
      inquiryId,
      message: 'CLAIM FOUND - INQUIRY COMPLETE',
      claim,
      financial,
      positions: decodePositions(positions),
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.status === 404) {
      incrementMetric('claim_inquiry.not_found', { route: ROUTE });
      recordTiming('claim_inquiry.latency', duration, { route: ROUTE });
      logger.info('Claim inquiry returned no record', { inquiryId, claimId, userId, service: SERVICE });
      throw error;
    }

    incrementMetric('claim_inquiry.failure', {
      route: ROUTE,
      errorClass: error.name,
    });
    recordTiming('claim_inquiry.latency', duration, {
      route: ROUTE,
      error: 'true',
    });

    logger.error('Claim inquiry failed', {
      inquiryId,
      claimId,
      userId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        claim_id: claimId,
        alert_path: 'instant',
      },
      extra: {
        inquiryId,
        claimId,
        userId,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/95d1a7d1.js \u2014 summarizeFinancials',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Claims Inquiry',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '95d1a7d1',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'claim_id', value: claimId },
      ],
      extra: {
        inquiryId,
        claimId,
        userId,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
    }).catch((alertError) => {
      logger.warn('Alert pipeline failed', { inquiryId, error: alertError.message, service: SERVICE });
    });

    throw error;
  }
}

module.exports = {
  inquireClaim,
  browsePositions,
  browseHistory,
  listClaims,
  summarizeFinancials,
  readClaimMaster,
  CLAIM_MASTER,
  CLAIM_POSITIONS,
  CLAIM_HISTORY,
  BENEFIT_SCHEDULES,
  ValidationError,
  NotFoundError,
};
