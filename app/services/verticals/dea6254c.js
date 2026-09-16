const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-dea6254c-investor-portal';
const ROUTE = '/api/dea6254c/portal-session';
const SLACK_MEMBER_ID = 'U08S7AVJ478';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `Custom-Devin-Demos/event-driven-devin`',
  '',
  'The failing code path is the investor portal login vertical:',
  '- Service: `app/services/verticals/dea6254c.js`',
  '- Route: `app/routes/verticals/dea6254c.js`',
  '- Page: `app/public/verticals/dea6254c.html` (served at `/dea6254c`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Reporting calendar for the investor portal. Capital statements are struck
 * as of the most recent month-end once the administrator has signed off NAV.
 */
const REPORTING_CALENDAR = {
  currentPeriodEnd: '2026-08-31',
  priorPeriodEnd: '2026-07-31',
  statementReleaseDay: 12,
};

/**
 * Fund registry. Each fund publishes NAV per unit on its own cadence and
 * offers one or more share classes with distinct fee and liquidity terms.
 */
const FUNDS = {
  WEL: {
    code: 'WEL',
    name: 'Wellington Multi-Strategy Fund',
    strategy: 'Multi-Strategy',
    baseCurrency: 'USD',
    navFrequency: 'monthly',
    navHistory: [
      { asOf: '2026-05-31', navPerUnit: 4128.66 },
      { asOf: '2026-06-30', navPerUnit: 4187.02 },
      { asOf: '2026-07-31', navPerUnit: 4231.48 },
      { asOf: '2026-08-31', navPerUnit: 4276.91 },
    ],
    shareClasses: {
      A: { managementFeeBps: 0, performanceFeeBps: 2000, redemptionNoticeDays: 90, lockupMonths: 12 },
      B: { managementFeeBps: 0, performanceFeeBps: 2250, redemptionNoticeDays: 65, lockupMonths: 6 },
    },
  },
  KEN: {
    code: 'KEN',
    name: 'Kensington Global Strategies Fund',
    strategy: 'Multi-Strategy',
    baseCurrency: 'USD',
    navFrequency: 'monthly',
    navHistory: [
      { asOf: '2026-05-31', navPerUnit: 2874.13 },
      { asOf: '2026-06-30', navPerUnit: 2902.77 },
      { asOf: '2026-07-31', navPerUnit: 2938.09 },
      { asOf: '2026-08-31', navPerUnit: 2961.54 },
    ],
    shareClasses: {
      A: { managementFeeBps: 0, performanceFeeBps: 2000, redemptionNoticeDays: 90, lockupMonths: 12 },
      B: { managementFeeBps: 0, performanceFeeBps: 2250, redemptionNoticeDays: 65, lockupMonths: 6 },
    },
  },
  TAC: {
    code: 'TAC',
    name: 'Tactical Trading Fund',
    strategy: 'Global Fixed Income & Macro',
    baseCurrency: 'USD',
    navFrequency: 'quarterly',
    navHistory: [
      { asOf: '2025-12-31', navPerUnit: 1614.20 },
      { asOf: '2026-03-31', navPerUnit: 1652.88 },
      { asOf: '2026-06-30', navPerUnit: 1698.35 },
    ],
    shareClasses: {
      I: { managementFeeBps: 100, performanceFeeBps: 2000, redemptionNoticeDays: 120, lockupMonths: 24 },
    },
  },
  GQS: {
    code: 'GQS',
    name: 'Global Equities Fund',
    strategy: 'Fundamental Equities',
    baseCurrency: 'USD',
    navFrequency: 'monthly',
    navHistory: [
      { asOf: '2026-05-31', navPerUnit: 987.41 },
      { asOf: '2026-06-30', navPerUnit: 1004.12 },
      { asOf: '2026-07-31', navPerUnit: 1018.77 },
      { asOf: '2026-08-31', navPerUnit: 1031.06 },
    ],
    shareClasses: {
      A: { managementFeeBps: 150, performanceFeeBps: 2000, redemptionNoticeDays: 60, lockupMonths: 12 },
    },
  },
};

/**
 * Institutional investors with portal access and their current fund holdings.
 */
const INVESTORS = {
  'INV-208431': {
    investorId: 'INV-208431',
    name: 'Halcyon State Employees Pension Trust',
    investorType: 'Public Pension',
    domicile: 'US',
    reportingCurrency: 'USD',
    relationshipManager: 'M. Okafor',
    holdings: [
      { fundCode: 'WEL', shareClass: 'A', units: 18420.5, costBasisPerUnit: 3512.40 },
      { fundCode: 'KEN', shareClass: 'B', units: 9210.25, costBasisPerUnit: 2610.15 },
      { fundCode: 'TAC', shareClass: 'I', units: 4150.0, costBasisPerUnit: 1498.00 },
    ],
  },
  'INV-114926': {
    investorId: 'INV-114926',
    name: 'Meridian University Endowment',
    investorType: 'Endowment',
    domicile: 'US',
    reportingCurrency: 'USD',
    relationshipManager: 'J. Lindqvist',
    holdings: [
      { fundCode: 'WEL', shareClass: 'B', units: 6210.0, costBasisPerUnit: 3890.22 },
      { fundCode: 'GQS', shareClass: 'A', units: 22400.0, costBasisPerUnit: 912.65 },
    ],
  },
};

const DEFAULT_INVESTOR_ID = 'INV-208431';

class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = code || 'INVALID_PORTAL_REQUEST';
  }
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function resolveInvestor(investorId) {
  const investor = INVESTORS[investorId || DEFAULT_INVESTOR_ID];
  if (!investor) {
    throw new ValidationError(`Investor ${investorId} is not enrolled for portal access`, 'INVESTOR_NOT_FOUND');
  }
  return investor;
}

function resolveFund(fundCode) {
  const fund = FUNDS[fundCode];
  if (!fund) {
    throw new ValidationError(`Fund ${fundCode} is not available in the registry`, 'FUND_NOT_FOUND');
  }
  return fund;
}

/**
 * Determine the statement period for this portal session. Statements are
 * always presented as of the latest signed-off month-end.
 */
function buildStatementPeriod() {
  return {
    asOf: REPORTING_CALENDAR.currentPeriodEnd,
    priorAsOf: REPORTING_CALENDAR.priorPeriodEnd,
    label: 'Monthly Capital Statement',
  };
}

/**
 * Look up the NAV strike for a fund as of the statement date. Funds that
 * strike NAV less often than monthly (e.g. quarterly) carry the most recent
 * strike on or before the statement date.
 */
function resolveValuationPoint(fund, asOf) {
  const history = Array.isArray(fund.navHistory) ? fund.navHistory : [];
  return history
    .filter((point) => point && typeof point.navPerUnit === 'number' && point.asOf <= asOf)
    .reduce((latest, point) => (!latest || point.asOf > latest.asOf ? point : latest), null);
}

function requireValuationPoint(fund, asOf) {
  const point = resolveValuationPoint(fund, asOf);
  if (!point) {
    throw new ValidationError(
      `Fund ${fund.code} has no NAV strike on or before ${asOf}`,
      'NAV_NOT_AVAILABLE',
    );
  }
  return point;
}

function resolveShareClassTerms(fund, shareClass) {
  const terms = fund.shareClasses[shareClass];
  if (!terms) {
    throw new ValidationError(`Share class ${shareClass} is not offered by ${fund.code}`, 'SHARE_CLASS_NOT_OFFERED');
  }
  return terms;
}

/**
 * Value a single holding at the statement date, including the period return
 * against the prior strike and the applicable share-class terms.
 */
function valueHolding(holding, period) {
  const fund = resolveFund(holding.fundCode);
  const terms = resolveShareClassTerms(fund, holding.shareClass);
  const current = requireValuationPoint(fund, period.asOf);
  const prior = resolveValuationPoint(fund, period.priorAsOf);

  const marketValue = roundMoney(holding.units * current.navPerUnit);
  const costBasis = roundMoney(holding.units * holding.costBasisPerUnit);
  const periodReturnPct = prior && prior.asOf !== current.asOf
    ? roundMoney(((current.navPerUnit / prior.navPerUnit) - 1) * 10000) / 100
    : null;

  return {
    fundCode: fund.code,
    fundName: fund.name,
    strategy: fund.strategy,
    shareClass: holding.shareClass,
    units: holding.units,
    navPerUnit: current.navPerUnit,
    valuationDate: current.asOf,
    marketValue,
    costBasis,
    unrealizedGain: roundMoney(marketValue - costBasis),
    periodReturnPct,
    redemptionNoticeDays: terms.redemptionNoticeDays,
    lockupMonths: terms.lockupMonths,
  };
}

/**
 * Roll individual holding valuations up into the portfolio summary shown on
 * the portal landing page.
 */
function summarizePortfolio(investor, period, positions) {
  const totalMarketValue = roundMoney(positions.reduce((sum, p) => sum + p.marketValue, 0));
  const totalCostBasis = roundMoney(positions.reduce((sum, p) => sum + p.costBasis, 0));

  return {
    investorId: investor.investorId,
    investorName: investor.name,
    reportingCurrency: investor.reportingCurrency,
    statement: period.label,
    asOf: period.asOf,
    totalMarketValue,
    totalCostBasis,
    totalUnrealizedGain: roundMoney(totalMarketValue - totalCostBasis),
    positions: positions.map((p) => ({
      ...p,
      allocationPct: totalMarketValue > 0
        ? roundMoney((p.marketValue / totalMarketValue) * 10000) / 100
        : 0,
    })),
  };
}

function issuePortalSession(investor, requestId) {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);
  return {
    sessionId: `PS-${requestId.slice(0, 8).toUpperCase()}`,
    investorId: investor.investorId,
    relationshipManager: investor.relationshipManager,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    entitlements: ['statements', 'capital-activity', 'tax-documents', 'fund-letters'],
  };
}

/**
 * Open an investor portal session: authenticate the investor record, strike
 * the current statement and return the portfolio summary for the landing page.
 */
async function openPortalSession(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const investorId = data.investorId || DEFAULT_INVESTOR_ID;

  logger.info('Opening investor portal session', {
    requestId,
    investorId,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const investor = resolveInvestor(investorId);
    const period = buildStatementPeriod();
    const positions = investor.holdings.map((holding) => valueHolding(holding, period));
    const portfolio = summarizePortfolio(investor, period, positions);
    const session = issuePortalSession(investor, requestId);

    const duration = Date.now() - startTime;
    incrementMetric('portal_session.success', { route: ROUTE, investorType: investor.investorType });
    recordTiming('portal_session.latency', duration, { route: ROUTE });

    logger.info('Investor portal session opened', {
      requestId,
      investorId,
      sessionId: session.sessionId,
      positions: positions.length,
      durationMs: duration,
      service: SERVICE,
    });

    return { success: true, requestId, session, portfolio };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error instanceof ValidationError) {
      incrementMetric('portal_session.rejected', { route: ROUTE, code: error.code });
      logger.warn('Investor portal session rejected', {
        requestId,
        investorId,
        code: error.code,
        error: error.message,
        service: SERVICE,
      });
      error.requestId = requestId;
      throw error;
    }

    incrementMetric('portal_session.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('portal_session.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Investor portal session failed', {
      requestId,
      investorId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, investorId },
      extra: { requestId, statementAsOf: REPORTING_CALENDAR.currentPeriodEnd },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/dea6254c.js \u2014 valueHolding',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Investor Portal Login',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'dea6254c',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'investorId', value: investorId },
      ],
      extra: { requestId, statementAsOf: REPORTING_CALENDAR.currentPeriodEnd },
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
      logger.error('Failed to create Devin session for investor portal error', {
        requestId,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  openPortalSession,
  valueHolding,
  resolveValuationPoint,
  buildStatementPeriod,
  FUNDS,
  INVESTORS,
  REPORTING_CALENDAR,
  DEFAULT_INVESTOR_ID,
};
