const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Morgan Stanley Online account holdings. Each position maps to the asset class
 * that drives its income-accrual and cost-basis treatment on the Holdings view.
 */
const POSITIONS = [
  { symbol: 'MSFT', name: 'Microsoft Corp', productType: 'stock', assetClass: 'equity', quantity: 42, lastPrice: 431.20, costBasis: 268.44 },
  { symbol: 'IVV', name: 'iShares Core S&P 500 ETF', productType: 'stock', assetClass: 'etf', quantity: 60, lastPrice: 588.11, costBasis: 402.19 },
  { symbol: 'CUIYX', name: 'Morgan Stanley Insight Fund Cl I', productType: 'mutual_fund', assetClass: 'mutual_fund', quantity: 210.442, lastPrice: 63.85, costBasis: 48.10 },
  { symbol: 'MGVIX', name: 'MS Global Opportunity Fund Cl I', productType: 'mutual_fund', assetClass: 'mutual_fund', quantity: 95.118, lastPrice: 41.02, costBasis: 33.77 },
];

/**
 * Registered income-accrual schedule. Each income code declares how the
 * projected annual income for a position is assessed and the rate/basis used.
 */
const INCOME_SCHEDULE = [
  { code: 'INC-DIV-QUALIFIED', name: 'Qualified Dividend', basis: 'yield', rate: 0.0072 },
  { code: 'INC-DIV-ETF', name: 'ETF Distribution', basis: 'yield', rate: 0.0131 },
  { code: 'INC-CAPGAIN-MF', name: 'Mutual Fund Capital Gain Distribution', basis: 'yield', rate: 0.0045 },
  { code: 'INC-INT-SWEEP', name: 'Bank Deposit Program Interest', basis: 'yield', rate: 0.0038 },
];

/**
 * Income profile per asset class, used to resolve the base income-accrual line
 * before any mandatory retirement accruals are layered on.
 */
const INCOME_PROFILE = {
  equity: { incomeCode: 'INC-DIV-QUALIFIED', label: 'Qualified Dividend' },
  etf: { incomeCode: 'INC-DIV-ETF', label: 'ETF Distribution' },
  mutual_fund: { incomeCode: 'INC-CAPGAIN-MF', label: 'Capital Gain Distribution' },
};

/**
 * Cost-basis lot method per registration type. Drives the unrealized gain/loss
 * disclosure tier reported back on the Holdings view.
 */
const REGISTRATION_METHOD = {
  'roth-ira': { method: 'average-cost', label: 'Average Cost (retirement)' },
  individual: { method: 'fifo', label: 'First In, First Out' },
  joint: { method: 'spec-id', label: 'Specific Identification' },
};

/**
 * Income accruals that are force-attached to every retirement (IRA) registration.
 * The foreign tax reclaim accrual must be reported so the projected annual income
 * is disclosed net of withholding, but its income code is not yet registered in
 * the INCOME_SCHEDULE catalog.
 */
const MANDATORY_RETIREMENT_ACCRUALS = [
  { code: 'INC-FTR-RECLAIM-2026', reason: 'Foreign tax reclaim accrual (retirement disclosure)' },
];

/**
 * Returns the unrealized gain/loss disclosure tier for a cost-basis lot method.
 */
function getDisclosureTier(method) {
  if (method === 'average-cost') return { tier: 'retirement', label: 'Retirement cost basis' };
  if (method === 'spec-id') return { tier: 'elective', label: 'Elective lot selection' };
  return { tier: 'standard', label: 'Standard lot ordering' };
}

/**
 * Layers the mandatory retirement income accruals onto the requested income
 * lines for IRA registrations.
 */
function applyRetirementAccruals(incomeLines, registration, assetClass) {
  const isRetirementIncome = registration === 'roth-ira' && (assetClass === 'equity' || assetClass === 'etf');
  if (!isRetirementIncome) return incomeLines;
  const accruals = MANDATORY_RETIREMENT_ACCRUALS.map((accrual) => ({ code: accrual.code, source: 'retirement' }));
  return [...incomeLines, ...accruals];
}

/**
 * Resolves a position to its base income-accrual line before mandatory
 * retirement accruals are applied.
 */
function resolveIncome(assetClass, registration) {
  const registrationConfig = REGISTRATION_METHOD[registration];
  if (!registrationConfig) {
    throw Object.assign(new Error(`Unknown registration type: ${registration}`), { code: 'INVALID_REGISTRATION' });
  }
  const profile = INCOME_PROFILE[assetClass];
  if (!profile) {
    throw Object.assign(new Error(`Unsupported asset class: ${assetClass}`), { code: 'INVALID_ASSET_CLASS' });
  }
  const tier = getDisclosureTier(registrationConfig.method);
  return {
    incomeLines: [{ code: profile.incomeCode, source: 'accrual' }],
    method: registrationConfig.method,
    disclosureTier: tier.tier,
    disclosureLabel: tier.label,
  };
}

/**
 * Builds the projected-income summary for a position — one line per assessed
 * income code, resolving each code to its schedule definition and rate.
 * BUG: INC-FTR-RECLAIM-2026 is not in INCOME_SCHEDULE, so incomeDef.rate crashes.
 */
function buildIncomeSummary(incomeLines, marketValue) {
  return incomeLines.map((line) => {
    const incomeDef = INCOME_SCHEDULE.find((f) => f.code === line.code);
    const amount = incomeDef.basis === 'yield'
      ? incomeDef.rate * marketValue
      : incomeDef.rate;
    return {
      code: line.code,
      name: incomeDef.name,
      basis: incomeDef.basis,
      rate: incomeDef.rate,
      source: line.source,
      amount: Number(amount.toFixed(2)),
    };
  });
}

/**
 * Refreshes a Morgan Stanley account's Holdings view — recomputes market value,
 * unrealized gain/loss, and projected annual income for every position.
 */
async function refreshHoldings(accountData) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Refreshing Morgan Stanley holdings', {
    requestId,
    accountId: accountData.accountId,
    registration: accountData.registration,
    positionCount: POSITIONS.length,
    service: 'morgan-stanley-holdings',
    route: '/api/15fee237/refresh',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const holdings = POSITIONS.map((position) => {
      const marketValue = Number((position.lastPrice * position.quantity).toFixed(2));
      const totalCost = Number((position.costBasis * position.quantity).toFixed(2));
      const unrealized = Number((marketValue - totalCost).toFixed(2));

      const income = resolveIncome(position.assetClass, accountData.registration);
      const incomeLines = applyRetirementAccruals(income.incomeLines, accountData.registration, position.assetClass);
      const incomeSummary = buildIncomeSummary(incomeLines, marketValue);
      const estAnnualIncome = Number(incomeSummary.reduce((sum, line) => sum + line.amount, 0).toFixed(2));

      return {
        symbol: position.symbol,
        name: position.name,
        productType: position.productType,
        quantity: position.quantity,
        lastPrice: position.lastPrice,
        marketValue,
        totalCost,
        unrealized,
        disclosureTier: income.disclosureTier,
        estAnnualIncome,
      };
    });

    const totalMarketValue = Number(holdings.reduce((sum, h) => sum + h.marketValue, 0).toFixed(2));
    const totalCost = Number(holdings.reduce((sum, h) => sum + h.totalCost, 0).toFixed(2));
    const estAnnualIncome = Number(holdings.reduce((sum, h) => sum + h.estAnnualIncome, 0).toFixed(2));
    const duration = Date.now() - startTime;

    incrementMetric('holdings.refresh.success', {
      route: '/api/15fee237/refresh',
      source: 'morgan-stanley-holdings',
    });
    recordTiming('holdings.refresh.latency', duration, {
      route: '/api/15fee237/refresh',
    });

    return {
      success: true,
      requestId,
      accountId: accountData.accountId,
      registration: accountData.registration,
      totalMarketValue,
      totalCost,
      estAnnualIncome,
      holdings,
      status: 'refreshed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('holdings.refresh.failure', {
      route: '/api/15fee237/refresh',
      errorClass: error.name,
      source: 'morgan-stanley-holdings',
    });
    recordTiming('holdings.refresh.latency', duration, {
      route: '/api/15fee237/refresh',
      error: 'true',
    });

    logger.error('Morgan Stanley holdings refresh failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountId: accountData.accountId,
      registration: accountData.registration,
      service: 'morgan-stanley-holdings',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/15fee237/refresh',
        service: 'morgan-stanley-holdings',
        source: 'morgan-stanley-holdings',
      },
      extra: {
        requestId,
        accountId: accountData.accountId,
        registration: accountData.registration,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/15fee237.js \u2014 buildIncomeSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '15fee237',
      devinUserId: accountData.devinUserId,
      devinEmail: accountData.devinEmail,
      devinOrgId: accountData.devinOrgId,
      service: 'morgan-stanley-holdings',
      verticalLabel: 'Morgan Stanley \u2014 Account Holdings Refresh',
      tags: [
        { key: 'route', value: '/api/15fee237/refresh' },
        { key: 'service', value: 'morgan-stanley-holdings' },
        { key: 'category', value: 'holdings-refresh' },
        { key: 'data_class', value: 'financial' },
      ],
      extra: { requestId, accountId: accountData.accountId, registration: accountData.registration },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'morgan-stanley-holdings@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Morgan Stanley holdings error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  refreshHoldings,
  buildIncomeSummary,
  applyRetirementAccruals,
  resolveIncome,
  POSITIONS,
  INCOME_SCHEDULE,
  REGISTRATION_METHOD,
};
