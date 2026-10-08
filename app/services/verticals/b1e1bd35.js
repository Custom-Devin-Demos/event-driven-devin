/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-b1e1bd35-pay-run-preview';
const ROUTE = '/api/b1e1bd35/pay-run-preview';
const SLACK_MEMBER_ID = process.env.CLOUDPAY_SLACK_MEMBER_ID || '';

const LATENCY_SLO = { budgetMs: 3000 };
const PROVIDER_POLL_POLICY = { latencyMs: [450, 550] };

const COUNTRIES = [
  { code: 'GB', country: 'United Kingdom', currency: 'GBP', provider: 'CloudPay UK Payroll Bureau', usdPerUnit: 1.27, avgMonthlyGross: 3900, netRatio: 0.74, flag: '🇬🇧' },
  { code: 'US', country: 'United States', currency: 'USD', provider: 'CloudPay US Payroll Services', usdPerUnit: 1, avgMonthlyGross: 6200, netRatio: 0.72, flag: '🇺🇸' },
  { code: 'IE', country: 'Ireland', currency: 'EUR', provider: 'CloudPay Ireland Payroll', usdPerUnit: 1.09, avgMonthlyGross: 4300, netRatio: 0.71, flag: '🇮🇪' },
  { code: 'DE', country: 'Germany', currency: 'EUR', provider: 'CloudPay Lohnbüro Deutschland', usdPerUnit: 1.09, avgMonthlyGross: 4800, netRatio: 0.64, flag: '🇩🇪' },
  { code: 'FR', country: 'France', currency: 'EUR', provider: 'CloudPay Paie France', usdPerUnit: 1.09, avgMonthlyGross: 4100, netRatio: 0.77, flag: '🇫🇷' },
  { code: 'NL', country: 'Netherlands', currency: 'EUR', provider: 'CloudPay Salarisadministratie NL', usdPerUnit: 1.09, avgMonthlyGross: 4500, netRatio: 0.70, flag: '🇳🇱' },
  { code: 'ES', country: 'Spain', currency: 'EUR', provider: 'CloudPay Nóminas España', usdPerUnit: 1.09, avgMonthlyGross: 2900, netRatio: 0.79, flag: '🇪🇸' },
  { code: 'IN', country: 'India', currency: 'INR', provider: 'CloudPay India Payroll Partner', usdPerUnit: 0.012, avgMonthlyGross: 150000, netRatio: 0.86, flag: '🇮🇳' },
  { code: 'SG', country: 'Singapore', currency: 'SGD', provider: 'CloudPay Singapore Payroll', usdPerUnit: 0.74, avgMonthlyGross: 6500, netRatio: 0.80, flag: '🇸🇬' },
  { code: 'AU', country: 'Australia', currency: 'AUD', provider: 'CloudPay Australia Payroll', usdPerUnit: 0.66, avgMonthlyGross: 8200, netRatio: 0.76, flag: '🇦🇺' },
  { code: 'JP', country: 'Japan', currency: 'JPY', provider: 'CloudPay Japan Kyuyo Center', usdPerUnit: 0.0067, avgMonthlyGross: 420000, netRatio: 0.78, flag: '🇯🇵' },
  { code: 'BR', country: 'Brazil', currency: 'BRL', provider: 'CloudPay Folha de Pagamento Brasil', usdPerUnit: 0.18, avgMonthlyGross: 9500, netRatio: 0.73, flag: '🇧🇷' },
  { code: 'MX', country: 'Mexico', currency: 'MXN', provider: 'CloudPay Nómina México', usdPerUnit: 0.055, avgMonthlyGross: 32000, netRatio: 0.83, flag: '🇲🇽' },
  { code: 'ZA', country: 'South Africa', currency: 'ZAR', provider: 'CloudPay South Africa Payroll', usdPerUnit: 0.054, avgMonthlyGross: 38000, netRatio: 0.75, flag: '🇿🇦' },
];

const SCOPE_OPTIONS = {
  all: { label: 'All CloudPay countries (14 in-country providers)', countries: COUNTRIES.map((c) => c.code) },
  gb: { label: 'United Kingdom only', countries: ['GB'] },
  us: { label: 'United States only', countries: ['US'] },
  sg: { label: 'Singapore only', countries: ['SG'] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the CloudPay multi-country pay-run preview:',
  '- Service: `app/services/verticals/b1e1bd35.js`',
  '- Route: `app/routes/verticals/b1e1bd35.js`',
  '- Page: `app/public/verticals/b1e1bd35.html` (served at `/cloudpay`)',
  '- Test: `tests/b1e1bd35-pay-run-preview.test.js`',
  '',
  'Pay-run previews for the default "All CloudPay countries" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `pollInCountryProviders` and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-provider poll latency.',
  'Preserve the response payload for every scope, including the country order in `countries` (CloudPay directory order) and the totals.',
  'Run `npx jest tests/b1e1bd35-pay-run-preview.test.js --runInBand` and `npm run lint`.',
  'Verify the default request at `/cloudpay` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashValue(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDay(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function lastWeekdayOfMonth(year, monthIndex) {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date;
}

function weekdaysBefore(date, count) {
  const result = new Date(date.getTime());
  let remaining = count;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() - 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

function payCalendar(now) {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const key = `${year}-${pad2(monthIndex + 1)}`;
  const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(now);
  const payDate = lastWeekdayOfMonth(year, monthIndex);
  const inputCutoff = weekdaysBefore(payDate, 5);
  return {
    payPeriod: { key, label },
    payDate: isoDay(payDate),
    inputCutoff: isoDay(inputCutoff),
    ratesAsOf: isoDay(now),
  };
}

async function fetchProviderPayRunPreview(code, request) {
  const [min, max] = PROVIDER_POLL_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const entry = COUNTRIES.find((c) => c.code === code);
  const seed = hashValue(`${request.companyName.toLowerCase()}:${request.payPeriod.key}:${code}`);
  const headcount = 20 + (seed % 381);
  const grossLocal = Math.round(headcount * entry.avgMonthlyGross * (0.95 + (seed % 11) / 100));
  const netLocal = Math.round(grossLocal * entry.netRatio);
  const status = (seed >>> 5) % 4 === 0 ? 'Awaiting inputs' : 'Ready for approval';

  return {
    countryCode: entry.code,
    country: entry.country,
    flag: entry.flag,
    currency: entry.currency,
    provider: entry.provider,
    headcount,
    grossLocal,
    netLocal,
    usdPerUnit: entry.usdPerUnit,
    grossUsd: round2(grossLocal * entry.usdPerUnit),
    netUsd: round2(netLocal * entry.usdPerUnit),
    status,
    inputCutoff: request.inputCutoff,
    payDate: request.payDate,
  };
}

/**
 * Poll each in-country payroll provider for its pay-run preview, in CloudPay directory order.
 */
async function pollInCountryProviders(countryCodes, request) {
  const previews = [];
  for (const code of countryCodes) previews.push(await fetchProviderPayRunPreview(code, request));
  return previews;
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizeRequest(data) {
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    companyName: String(requestData.companyName === undefined ? '' : requestData.companyName).trim(),
    email: String(requestData.email === undefined ? '' : requestData.email).trim().toLowerCase(),
    scope: String(requestData.scope === undefined ? 'all' : requestData.scope).trim().toLowerCase(),
  };

  if (normalized.companyName.length < 2 || normalized.companyName.length > 120) {
    throw validationError('Enter your company name (2–120 characters).', 'COMPANY_NAME_INVALID');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
    throw validationError('Enter a valid email address.', 'EMAIL_INVALID');
  }
  if (!Object.hasOwn(SCOPE_OPTIONS, normalized.scope)) {
    throw validationError('Choose a valid country scope.', 'SCOPE_INVALID');
  }

  return normalized;
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, countriesPolled, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      countriesPolled,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/b1e1bd35.js — pollInCountryProviders',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'CloudPay Multi-Country Pay-Run Preview',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'b1e1bd35',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      countriesPolled,
    },
    level: 'warning',
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
    logger.error('Failed to create Devin session for CloudPay pay-run preview latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function previewPayRun(data = {}) {
  const startTime = Date.now();
  const requestId = `CP-${uuidv4().slice(0, 8).toUpperCase()}`;
  let normalized;
  try {
    normalized = normalizeRequest(data);
  } catch (error) {
    error.requestId = requestId;
    throw error;
  }
  const scope = SCOPE_OPTIONS[normalized.scope];
  const calendar = payCalendar(new Date());
  const payRunId = `PR-${calendar.payPeriod.key.replace('-', '')}-${(hashValue(normalized.companyName.toLowerCase()) % 9000) + 1000}`;

  logger.info('Previewing CloudPay multi-country pay run', {
    requestId,
    payRunId,
    scope: normalized.scope,
    service: SERVICE,
    route: ROUTE,
  });

  const request = {
    companyName: normalized.companyName,
    payPeriod: calendar.payPeriod,
    payDate: calendar.payDate,
    inputCutoff: calendar.inputCutoff,
  };
  const previews = await pollInCountryProviders(scope.countries, request);
  const durationMs = Date.now() - startTime;

  incrementMetric('pay_run_preview.success', {
    route: ROUTE,
    scope: normalized.scope,
  });
  recordTiming('pay_run_preview.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('pay_run_preview.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
    });
    logger.warn('CloudPay pay-run preview exceeded latency budget — triggering Devin', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      countriesPolled: scope.countries.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      countriesPolled: scope.countries.length,
      data: {
        ...normalized,
        devinUserId: data.devinUserId,
        devinOrgId: data.devinOrgId,
        devinEmail: data.devinEmail,
      },
    }));
  }

  const totals = previews.reduce((acc, preview) => ({
    headcount: acc.headcount + preview.headcount,
    grossUsd: acc.grossUsd + preview.grossUsd,
    netUsd: acc.netUsd + preview.netUsd,
  }), { headcount: 0, grossUsd: 0, netUsd: 0 });

  return {
    success: true,
    requestId,
    payRunId,
    companyName: normalized.companyName,
    email: normalized.email,
    scope: { key: normalized.scope, label: scope.label },
    payPeriod: calendar.payPeriod,
    payDate: calendar.payDate,
    inputCutoff: calendar.inputCutoff,
    ratesAsOf: calendar.ratesAsOf,
    countriesPolled: scope.countries.length,
    countries: previews,
    totals: {
      headcount: totals.headcount,
      grossUsd: round2(totals.grossUsd),
      netUsd: round2(totals.netUsd),
    },
    durationMs,
  };
}

module.exports = {
  previewPayRun,
  payCalendar,
  COUNTRIES,
  SCOPE_OPTIONS,
  PROVIDER_POLL_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
