const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.BLUEOWL_SLACK_MEMBER_ID || 'U0B7F46NVA4';

const SERVICE = 'customer-dfa29484-capital-account-statements';
const ROUTE = '/api/dfa29484/statements';

const INVESTOR = {
  id: 'lp_meridian_strs',
  name: 'Meridian State Teachers\u2019 Retirement System',
  type: 'Public pension',
  domicile: 'United States',
  user: { name: 'Elena Marsh', title: 'Director, Private Markets', initials: 'EM' },
  coverage: { name: 'Thomas Reyes', title: 'Managing Director, Investor Relations' },
};

const PERIODS = [
  { id: '2026Q3', label: 'Q3 2026', asOf: '2026-09-30', status: 'final' },
  { id: '2026Q2', label: 'Q2 2026', asOf: '2026-06-30', status: 'final' },
  { id: '2026Q1', label: 'Q1 2026', asOf: '2026-03-31', status: 'final' },
];

const VEHICLES = [
  {
    id: 'OCDL-IV',
    name: 'Owl Credit Direct Lending Fund IV',
    strategy: 'Credit \u2014 Direct Lending',
    vintage: 2023,
    currency: 'USD',
    commitment: 150000000,
    called: 112500000,
    distributed: 31200000,
    nav: 98650000,
    feeTerms: 'Invested capital \u00b7 1.25%',
    sideLetter: false,
  },
  {
    id: 'GPSC-V',
    name: 'Blue Owl GP Strategic Capital Fund V',
    strategy: 'GP Strategic Capital',
    vintage: 2022,
    currency: 'USD',
    commitment: 100000000,
    called: 64000000,
    distributed: 9800000,
    nav: 71400000,
    feeTerms: 'Committed capital \u00b7 1.50%',
    sideLetter: false,
  },
  {
    id: 'NLRE-II',
    name: 'Blue Owl Net Lease Real Estate II',
    strategy: 'Real Estate \u2014 Net Lease',
    vintage: 2024,
    currency: 'USD',
    commitment: 75000000,
    called: 51000000,
    distributed: 12400000,
    nav: 54200000,
    feeTerms: 'NAV \u00b7 1.00%',
    sideLetter: false,
  },
  {
    id: 'ORTI-CI',
    name: 'Owl Rock Technology Income Co-Invest',
    strategy: 'Credit \u2014 Technology Co-Invest',
    vintage: 2025,
    currency: 'USD',
    commitment: 40000000,
    called: 28000000,
    distributed: 2100000,
    nav: 30900000,
    feeTerms: 'Fee-free (side letter \u00a74.2)',
    sideLetter: true,
  },
];

/**
 * Quarterly allocation records as delivered by the fund administrator feed.
 * Commingled vehicles carry a `managementFee` block; the co-invest sleeve is
 * fee-free under the LP's side letter, so the administrator omits the block.
 */
const FUND_ADMIN_FEED = {
  '2026Q3': {
    'OCDL-IV': {
      beginningBalance: 96120000,
      contributions: 7500000,
      distributions: 6200000,
      netInvestmentIncome: 2415000,
      realizedGain: 310000,
      unrealizedGain: -840000,
      managementFee: { basis: 'Invested Capital', rateBps: 125, accrued: 351562.5 },
      carriedInterest: { accrued: 303437.5, hurdleBps: 700 },
      endingBalance: 98650000,
    },
    'GPSC-V': {
      beginningBalance: 68900000,
      contributions: 4000000,
      distributions: 2200000,
      netInvestmentIncome: 1120000,
      realizedGain: 0,
      unrealizedGain: -45000,
      managementFee: { basis: 'Committed Capital', rateBps: 150, accrued: 375000 },
      carriedInterest: { accrued: 0, hurdleBps: 800 },
      endingBalance: 71400000,
    },
    'NLRE-II': {
      beginningBalance: 52350000,
      contributions: 3000000,
      distributions: 1900000,
      netInvestmentIncome: 780000,
      realizedGain: 0,
      unrealizedGain: 100375,
      managementFee: { basis: 'NAV', rateBps: 100, accrued: 130375 },
      carriedInterest: { accrued: 0, hurdleBps: 600 },
      endingBalance: 54200000,
    },
    'ORTI-CI': {
      beginningBalance: 29240000,
      contributions: 2000000,
      distributions: 900000,
      netInvestmentIncome: 612000,
      realizedGain: 0,
      unrealizedGain: -52000,
      carriedInterest: { accrued: 0, hurdleBps: 0 },
      endingBalance: 30900000,
    },
  },
};

const STATEMENTS = [
  { id: 'STMT-2026Q2-0417', periodId: '2026Q2', vehicleIds: ['OCDL-IV', 'GPSC-V', 'NLRE-II'], format: 'pdf', generatedAt: '2026-07-21T14:02:11.000Z', pages: 9 },
  { id: 'STMT-2026Q1-0388', periodId: '2026Q1', vehicleIds: ['OCDL-IV', 'GPSC-V', 'NLRE-II'], format: 'pdf', generatedAt: '2026-04-19T09:48:36.000Z', pages: 9 },
];

const inFlight = new Set();

function periodLabel(periodId) {
  const p = PERIODS.find((x) => x.id === periodId);
  return p ? p.label : periodId;
}

function publicStatement(stmt) {
  return {
    id: stmt.id,
    periodId: stmt.periodId,
    period: periodLabel(stmt.periodId),
    vehicleIds: stmt.vehicleIds,
    format: stmt.format,
    generatedAt: stmt.generatedAt,
    pages: stmt.pages,
    downloadUrl: stmt.format === 'csv' ? `/api/dfa29484/statements/${stmt.id}/download` : null,
  };
}

function getCapitalAccount() {
  const totals = VEHICLES.reduce((acc, v) => ({
    commitment: acc.commitment + v.commitment,
    called: acc.called + v.called,
    distributed: acc.distributed + v.distributed,
    nav: acc.nav + v.nav,
  }), { commitment: 0, called: 0, distributed: 0, nav: 0 });

  return {
    investor: INVESTOR,
    asOf: PERIODS[0].asOf,
    totals: { ...totals, unfunded: totals.commitment - totals.called },
    periods: PERIODS,
    vehicles: VEHICLES.map((v) => ({ ...v, unfunded: v.commitment - v.called })),
    statements: STATEMENTS.map(publicStatement).sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1)),
  };
}

function clientError(message, code, statusCode) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validateRequest(data) {
  const periodId = String(data.periodId || '').trim();
  if (!PERIODS.some((p) => p.id === periodId)) {
    throw clientError('Select a reporting period.', 'PERIOD_INVALID', 400);
  }
  const vehicleIds = Array.isArray(data.vehicleIds) ? data.vehicleIds.map(String) : [];
  if (vehicleIds.length === 0) {
    throw clientError('Select at least one vehicle.', 'NO_VEHICLES_SELECTED', 400);
  }
  const unknown = vehicleIds.filter((id) => !VEHICLES.some((v) => v.id === id));
  if (unknown.length) {
    throw clientError(`Unknown vehicle: ${unknown.join(', ')}.`, 'VEHICLE_UNKNOWN', 400);
  }
  const format = String(data.format || 'pdf').toLowerCase();
  if (!['pdf', 'csv'].includes(format)) {
    throw clientError('Format must be PDF or CSV.', 'FORMAT_INVALID', 400);
  }
  const ordered = VEHICLES.filter((v) => vehicleIds.includes(v.id)).map((v) => v.id);
  return { periodId, vehicleIds: ordered, format };
}

/**
 * Pull the LP's allocation record for a vehicle from the fund administrator feed.
 */
function pullAllocation(vehicleId, periodId) {
  const period = FUND_ADMIN_FEED[periodId] || {};
  const record = period[vehicleId];
  if (!record) {
    throw clientError(`No allocation on file for ${vehicleId} in ${periodLabel(periodId)}.`, 'ALLOCATION_MISSING', 409);
  }
  return { vehicleId, periodId, ...record };
}

/**
 * Lift the fee terms off an allocation record so the waterfall can apply them.
 */
function resolveFeeTerms(allocation) {
  const fee = allocation.managementFee || {};
  return {
    basis: fee.basis,
    rateBps: fee.rateBps,
    accrued: fee.accrued,
  };
}

/**
 * Normalise the administrator's free-text fee basis into the statement
 * vocabulary (`invested_capital`, `committed_capital`, `nav`).
 */
function normalizeFeeBasis(basis) {
  return basis.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Apply the fee waterfall to an allocation and produce the statement line items.
 */
function applyFeeWaterfall(allocation) {
  const terms = resolveFeeTerms(allocation);
  const basis = normalizeFeeBasis(terms.basis);
  const feeAccrued = Number(terms.accrued || 0);
  const carry = allocation.carriedInterest ? Number(allocation.carriedInterest.accrued || 0) : 0;

  const grossChange = allocation.netInvestmentIncome + allocation.realizedGain + allocation.unrealizedGain;
  const netChange = grossChange - feeAccrued - carry;

  return {
    feeBasis: basis,
    feeRateBps: terms.rateBps,
    managementFee: feeAccrued,
    carriedInterest: carry,
    grossChange,
    netChange,
  };
}

function money(n) {
  return Number(n).toFixed(2);
}

/**
 * Render a single statement row for one vehicle.
 */
function renderStatementRow(vehicle, allocation, waterfall) {
  return {
    vehicleId: vehicle.id,
    vehicleName: vehicle.name,
    beginningBalance: money(allocation.beginningBalance),
    contributions: money(allocation.contributions),
    distributions: money(allocation.distributions),
    netInvestmentIncome: money(allocation.netInvestmentIncome),
    realizedGain: money(allocation.realizedGain),
    unrealizedGain: money(allocation.unrealizedGain),
    managementFee: money(waterfall.managementFee),
    carriedInterest: money(waterfall.carriedInterest),
    endingBalance: money(allocation.endingBalance),
    feeBasis: waterfall.feeBasis,
    feeRateBps: waterfall.feeRateBps,
  };
}

async function generateStatement(data) {
  const startTime = Date.now();
  const requestId = `req_${uuidv4().slice(0, 8)}`;
  const request = validateRequest(data || {});
  const lockKey = `${INVESTOR.id}:${request.periodId}`;

  logger.info('Capital account statement requested', {
    requestId, investorId: INVESTOR.id, periodId: request.periodId, vehicles: request.vehicleIds, format: request.format, service: SERVICE, route: ROUTE,
  });

  if (inFlight.has(lockKey)) {
    throw clientError(`A ${periodLabel(request.periodId)} statement is already being generated for this account.`, 'STATEMENT_IN_PROGRESS', 409);
  }
  inFlight.add(lockKey);

  const rows = [];
  let currentVehicle = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 300));

    for (const vehicleId of request.vehicleIds) {
      currentVehicle = VEHICLES.find((v) => v.id === vehicleId);
      const allocation = pullAllocation(vehicleId, request.periodId);
      const waterfall = applyFeeWaterfall(allocation);
      rows.push(renderStatementRow(currentVehicle, allocation, waterfall));
    }

    const stmt = {
      id: `STMT-${request.periodId}-${String(400 + STATEMENTS.length + 1).padStart(4, '0')}`,
      periodId: request.periodId,
      vehicleIds: request.vehicleIds,
      format: request.format,
      generatedAt: new Date().toISOString(),
      pages: request.format === 'pdf' ? 3 + rows.length * 2 : null,
      rows,
    };
    STATEMENTS.push(stmt);

    const duration = Date.now() - startTime;
    incrementMetric('capital_account_statement.success', { route: ROUTE });
    recordTiming('capital_account_statement.latency', duration, { route: ROUTE });
    logger.info('Capital account statement generated', {
      requestId, statementId: stmt.id, investorId: INVESTOR.id, periodId: request.periodId, vehicles: rows.length, durationMs: duration,
    });

    return { success: true, requestId, statement: publicStatement(stmt), rows };
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) {
      error.requestId = requestId;
      throw error;
    }

    const duration = Date.now() - startTime;
    const vehicleId = currentVehicle ? currentVehicle.id : null;
    incrementMetric('capital_account_statement.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('capital_account_statement.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Capital account statement failed', {
      requestId, investorId: INVESTOR.id, periodId: request.periodId, vehicleId, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, vehicle: vehicleId, period: request.periodId, alert_path: 'instant' },
      extra: { requestId, investorId: INVESTOR.id, format: request.format, renderedVehicles: rows.map((r) => r.vehicleId) },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/dfa29484.js \u2014 normalizeFeeBasis',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Blue Owl Investor Portal \u2014 Generate capital account statement',
      customer: 'dfa29484',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'vehicle', value: vehicleId || 'unknown' },
        { key: 'period', value: request.periodId },
      ],
      extra: { requestId, investorId: INVESTOR.id, format: request.format, renderedVehicles: rows.map((r) => r.vehicleId) },
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
      logger.error('Failed to create Devin session for capital account statement error', { error: err.message, requestId });
    });

    error.requestId = requestId;
    error.code = error.code || 'STATEMENT_RENDER_FAILED';
    error.vehicleId = vehicleId;
    error.rows = rows;
    throw error;
  } finally {
    inFlight.delete(lockKey);
  }
}

function getStatementCsv(statementId) {
  const stmt = STATEMENTS.find((s) => s.id === statementId);
  if (!stmt) throw clientError('Statement not found.', 'STATEMENT_NOT_FOUND', 404);
  if (stmt.format !== 'csv' || !stmt.rows) throw clientError('Only CSV statements can be downloaded here.', 'FORMAT_NOT_DOWNLOADABLE', 409);
  const columns = ['vehicleId', 'vehicleName', 'beginningBalance', 'contributions', 'distributions', 'netInvestmentIncome', 'realizedGain', 'unrealizedGain', 'managementFee', 'carriedInterest', 'endingBalance'];
  const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [columns.join(',')].concat(stmt.rows.map((r) => columns.map((c) => escape(r[c])).join(',')));
  return { filename: `${stmt.id}.csv`, body: `${lines.join('\n')}\n` };
}

module.exports = {
  getCapitalAccount,
  generateStatement,
  getStatementCsv,
  VEHICLES,
  PERIODS,
};
