/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.SOVOS_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-5ac6319f-tax-authority-status';
const ROUTE = '/api/5ac6319f/tax-authority-status';

const LATENCY_SLO = { budgetMs: 3000 };
const AUTHORITY_POLL_POLICY = { latencyMs: [450, 550] };

const TAX_AUTHORITIES = {
  it_sdi: {
    country: 'Italy',
    countryCode: 'IT',
    authority: 'SdI',
    format: 'FatturaPA',
    mandate: 'B2B + B2G clearance',
    documents: 166,
    cleared: 85,
    pending: 40,
    warnings: 23,
    rejected: 18,
  },
  pl_ksef: {
    country: 'Poland',
    countryCode: 'PL',
    authority: 'KSeF',
    format: 'FA(3)',
    mandate: 'B2B + B2G clearance',
    documents: 143,
    cleared: 75,
    pending: 32,
    warnings: 20,
    rejected: 16,
  },
  fr_ppf: {
    country: 'France',
    countryCode: 'FR',
    authority: 'PPF / Chorus Pro',
    format: 'Factur-X',
    mandate: 'B2B e-invoicing + e-reporting',
    documents: 100,
    cleared: 50,
    pending: 22,
    warnings: 14,
    rejected: 14,
  },
  de_xrechnung: {
    country: 'Germany',
    countryCode: 'DE',
    authority: 'ZRE / OZG-RE',
    format: 'XRechnung 3.0',
    mandate: 'B2G clearance',
    documents: 90,
    cleared: 45,
    pending: 20,
    warnings: 12,
    rejected: 13,
  },
  es_sii: {
    country: 'Spain',
    countryCode: 'ES',
    authority: 'AEAT SII',
    format: 'SII XML',
    mandate: 'Real-time reporting',
    documents: 89,
    cleared: 45,
    pending: 20,
    warnings: 12,
    rejected: 12,
  },
  gr_mydata: {
    country: 'Greece',
    countryCode: 'GR',
    authority: 'AADE myDATA',
    format: 'myDATA XML',
    mandate: 'Real-time reporting',
    documents: 75,
    cleared: 38,
    pending: 17,
    warnings: 10,
    rejected: 10,
  },
  hu_nav: {
    country: 'Hungary',
    countryCode: 'HU',
    authority: 'NAV Online Számla',
    format: 'NAV XML 3.0',
    mandate: 'Real-time reporting',
    documents: 71,
    cleared: 38,
    pending: 15,
    warnings: 9,
    rejected: 9,
  },
  ro_efactura: {
    country: 'Romania',
    countryCode: 'RO',
    authority: 'ANAF RO e-Factura',
    format: 'RO_CIUS UBL',
    mandate: 'B2B + B2G clearance',
    documents: 71,
    cleared: 38,
    pending: 15,
    warnings: 8,
    rejected: 10,
  },
  rs_sef: {
    country: 'Serbia',
    countryCode: 'RS',
    authority: 'SEF',
    format: 'UBL 2.1',
    mandate: 'B2B + B2G clearance',
    documents: 59,
    cleared: 32,
    pending: 12,
    warnings: 7,
    rejected: 8,
  },
  tr_gib: {
    country: 'Türkiye',
    countryCode: 'TR',
    authority: 'GİB',
    format: 'e-Fatura UBL-TR',
    mandate: 'B2B e-invoicing',
    documents: 82,
    cleared: 42,
    pending: 18,
    warnings: 11,
    rejected: 11,
  },
  sa_zatca: {
    country: 'Saudi Arabia',
    countryCode: 'SA',
    authority: 'ZATCA FATOORA',
    format: 'UBL 2.1 Phase 2',
    mandate: 'B2B + B2G clearance',
    documents: 80,
    cleared: 40,
    pending: 18,
    warnings: 10,
    rejected: 12,
  },
  mx_sat: {
    country: 'Mexico',
    countryCode: 'MX',
    authority: 'SAT',
    format: 'CFDI 4.0',
    mandate: 'Real-time reporting',
    documents: 114,
    cleared: 60,
    pending: 25,
    warnings: 14,
    rejected: 15,
  },
  br_sefaz: {
    country: 'Brazil',
    countryCode: 'BR',
    authority: 'SEFAZ',
    format: 'NF-e 4.0',
    mandate: 'B2B + B2G clearance',
    documents: 103,
    cleared: 55,
    pending: 22,
    warnings: 12,
    rejected: 14,
  },
  in_irp: {
    country: 'India',
    countryCode: 'IN',
    authority: 'IRP',
    format: 'e-Invoice JSON',
    mandate: 'B2B e-invoicing',
    documents: 57,
    cleared: 33,
    pending: 10,
    warnings: 7,
    rejected: 7,
  },
};

const ALL_AUTHORITIES = Object.keys(TAX_AUTHORITIES);

const SCOPE_OPTIONS = {
  all: { label: 'All tax authorities', authorities: ALL_AUTHORITIES },
  ...Object.fromEntries(ALL_AUTHORITIES.map((key) => [
    key,
    {
      label: `${TAX_AUTHORITIES[key].country} — ${TAX_AUTHORITIES[key].authority}`,
      authorities: [key],
    },
  ])),
};

const DOCUMENTS = [
  {
    id: 'INV-DE-2026-004211',
    country: 'Germany',
    countryCode: 'DE',
    authority: 'ZRE / OZG-RE',
    format: 'XRechnung 3.0',
    buyer: 'Hanseatic Components GmbH',
    amount: 28450.75,
    currency: 'EUR',
    status: 'rejected',
    lifecycle: 'Submitted',
    submittedAt: '2026-10-21T15:42:00.000Z',
  },
  {
    id: 'INV-IT-2026-018734',
    country: 'Italy',
    countryCode: 'IT',
    authority: 'SdI',
    format: 'FatturaPA',
    buyer: 'Alba Robotics S.r.l.',
    amount: 12680,
    currency: 'EUR',
    status: 'cleared',
    lifecycle: 'Delivered',
    submittedAt: '2026-10-21T15:18:00.000Z',
  },
  {
    id: 'INV-PL-2026-006305',
    country: 'Poland',
    countryCode: 'PL',
    authority: 'KSeF',
    format: 'FA(3)',
    buyer: 'Vistula Medical Sp. z o.o.',
    amount: 94750.5,
    currency: 'PLN',
    status: 'pending',
    lifecycle: 'Submitted',
    submittedAt: '2026-10-21T14:53:00.000Z',
  },
  {
    id: 'INV-MX-2026-002519',
    country: 'Mexico',
    countryCode: 'MX',
    authority: 'SAT',
    format: 'CFDI 4.0',
    buyer: 'Nube Clara Logística S.A. de C.V.',
    amount: 173800,
    currency: 'MXN',
    status: 'warnings',
    lifecycle: 'Submitted',
    submittedAt: '2026-10-21T14:21:00.000Z',
  },
  {
    id: 'INV-BR-2026-009104',
    country: 'Brazil',
    countryCode: 'BR',
    authority: 'SEFAZ',
    format: 'NF-e 4.0',
    buyer: 'Horizonte Verde Equipamentos Ltda.',
    amount: 58230.9,
    currency: 'BRL',
    status: 'cleared',
    lifecycle: 'Cleared',
    submittedAt: '2026-10-21T13:57:00.000Z',
  },
  {
    id: 'INV-FR-2026-007832',
    country: 'France',
    countryCode: 'FR',
    authority: 'PPF / Chorus Pro',
    format: 'Factur-X',
    buyer: 'Atelier Rivière SAS',
    amount: 18900,
    currency: 'EUR',
    status: 'pending',
    lifecycle: 'Submitted',
    submittedAt: '2026-10-21T13:06:00.000Z',
  },
  {
    id: 'INV-SA-2026-001862',
    country: 'Saudi Arabia',
    countryCode: 'SA',
    authority: 'ZATCA FATOORA',
    format: 'UBL 2.1 Phase 2',
    buyer: 'Desert Meridian Trading Co.',
    amount: 42150,
    currency: 'SAR',
    status: 'rejected',
    lifecycle: 'Submitted',
    submittedAt: '2026-10-21T12:34:00.000Z',
  },
  {
    id: 'INV-ES-2026-010045',
    country: 'Spain',
    countryCode: 'ES',
    authority: 'AEAT SII',
    format: 'SII XML',
    buyer: 'Costa Norte Energía S.L.',
    amount: 7530.8,
    currency: 'EUR',
    status: 'cleared',
    lifecycle: 'Archived',
    submittedAt: '2026-10-21T11:49:00.000Z',
  },
  {
    id: 'INV-IN-2026-003708',
    country: 'India',
    countryCode: 'IN',
    authority: 'IRP',
    format: 'e-Invoice JSON',
    buyer: 'Asterion Precision Systems Pvt. Ltd.',
    amount: 624000,
    currency: 'INR',
    status: 'pending',
    lifecycle: 'Submitted',
    submittedAt: '2026-10-20T18:17:00.000Z',
  },
  {
    id: 'INV-TR-2026-005491',
    country: 'Türkiye',
    countryCode: 'TR',
    authority: 'GİB',
    format: 'e-Fatura UBL-TR',
    buyer: 'Mavi Liman Teknoloji A.Ş.',
    amount: 316500,
    currency: 'TRY',
    status: 'warnings',
    lifecycle: 'Submitted',
    submittedAt: '2026-10-20T16:02:00.000Z',
  },
  {
    id: 'INV-RO-2026-001943',
    country: 'Romania',
    countryCode: 'RO',
    authority: 'ANAF RO e-Factura',
    format: 'RO_CIUS UBL',
    buyer: 'Carpathia Diagnostics S.R.L.',
    amount: 22100,
    currency: 'RON',
    status: 'rejected',
    lifecycle: 'Submitted',
    submittedAt: '2026-10-20T10:28:00.000Z',
  },
  {
    id: 'INV-RS-2026-000782',
    country: 'Serbia',
    countryCode: 'RS',
    authority: 'SEF',
    format: 'UBL 2.1',
    buyer: 'Dunav Industrial Partners d.o.o.',
    amount: 1440000,
    currency: 'RSD',
    status: 'cleared',
    lifecycle: 'Delivered',
    submittedAt: '2026-10-19T09:14:00.000Z',
  },
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Sovos Compliance Network tax authority status refresh:',
  '- Service: `app/services/verticals/5ac6319f.js`',
  '- Route: `app/routes/verticals/5ac6319f.js`',
  '- Page: `app/public/verticals/5ac6319f.html` (served at `/sovos`)',
  '- Test: `tests/5ac6319f-tax-authority-status.test.js`',
  '',
  'The default "All tax authorities" refresh succeeds but takes ~7s against the 3000ms latency budget. The culprit is `pollTaxAuthorityStatuses`.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-call latency.',
  'Preserve the response payload and per-authority result order.',
  'Run `npx jest tests/5ac6319f-tax-authority-status.test.js --runInBand` and `npx eslint app/routes/verticals/5ac6319f.js app/services/verticals/5ac6319f.js app/routes/sentry-webhook.js config/customers/5ac6319f.js`.',
  'Verify the default tax authority status refresh at `/sovos` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

async function fetchAuthorityStatus(key) {
  const [min, max] = AUTHORITY_POLL_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const authority = TAX_AUTHORITIES[key];
  return {
    key,
    country: authority.country,
    countryCode: authority.countryCode,
    authority: authority.authority,
    format: authority.format,
    mandate: authority.mandate,
    documents: authority.documents,
    cleared: authority.cleared,
    pending: authority.pending,
    warnings: authority.warnings,
    rejected: authority.rejected,
    lastSyncAt: new Date().toISOString(),
  };
}

async function pollTaxAuthorityStatuses(authorities) {
  const results = [];
  for (const key of authorities) {
    results.push(await fetchAuthorityStatus(key));
  }
  return results;
}

function summarize(results) {
  const totals = results.reduce((summary, authority) => ({
    documents: summary.documents + authority.documents,
    cleared: summary.cleared + authority.cleared,
    pending: summary.pending + authority.pending,
    warnings: summary.warnings + authority.warnings,
    rejected: summary.rejected + authority.rejected,
  }), {
    documents: 0,
    cleared: 0,
    pending: 0,
    warnings: 0,
    rejected: 0,
  });
  const clearanceRate = totals.documents
    ? Number((((totals.cleared + totals.warnings) / totals.documents) * 100).toFixed(1))
    : 100;

  return {
    ...totals,
    clearanceRate,
    connectedAuthorities: results.length,
    authoritiesWithRejections: results.filter((authority) => authority.rejected > 0).length,
  };
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, authoritiesChecked, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      alert_path: 'latency',
      route: ROUTE,
      service: SERVICE,
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      authoritiesChecked,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/5ac6319f.js — pollTaxAuthorityStatuses',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Sovos Compliance Network Tax Authority Status',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '5ac6319f',
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
      authoritiesChecked,
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
    logger.error('Failed to create Devin session for Sovos tax authority status latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runTaxAuthorityStatus(data = {}) {
  const startTime = Date.now();
  const checkId = `TAS-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    scope: String(requestData.scope || 'all').trim().toLowerCase(),
  };

  if (!Object.hasOwn(SCOPE_OPTIONS, normalized.scope)) {
    const error = new Error('Select a valid tax authority scope.');
    error.name = 'ValidationError';
    error.code = 'TAX_STATUS_INVALID';
    error.statusCode = 400;
    throw error;
  }

  const scope = SCOPE_OPTIONS[normalized.scope];
  logger.info('Running Sovos tax authority status check', {
    checkId,
    scope: normalized.scope,
    authorities: scope.authorities.length,
    service: SERVICE,
    route: ROUTE,
  });

  const results = await pollTaxAuthorityStatuses(scope.authorities);
  const summary = summarize(results);
  const durationMs = Date.now() - startTime;

  incrementMetric('tax_authority_status.success', {
    route: ROUTE,
    scope: normalized.scope,
  });
  recordTiming('tax_authority_status.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('tax_authority_status.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
    });
    logger.warn('Sovos tax authority status exceeded latency budget', {
      checkId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      authoritiesChecked: results.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    logger.warn('Sovos tax authority status latency breach — triggering Devin session', {
      checkId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: checkId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      authoritiesChecked: results.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    checkId,
    scope: {
      key: normalized.scope,
      label: scope.label,
    },
    authoritiesChecked: results.length,
    results,
    summary,
    durationMs,
  };
}

module.exports = {
  runTaxAuthorityStatus,
  summarize,
  TAX_AUTHORITIES,
  ALL_AUTHORITIES,
  SCOPE_OPTIONS,
  DOCUMENTS,
  AUTHORITY_POLL_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
