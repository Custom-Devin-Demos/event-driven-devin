/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.EPIQ_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-37b90289-case-search';
const ROUTE = '/api/37b90289/case-search';

const LATENCY_SLO = { budgetMs: 3000 };
const DOCKET_QUERY_POLICY = { latencyMs: [450, 550] };

const COURTS = {
  DEDE: { label: 'D. Delaware' },
  NYSB: { label: 'S.D. New York' },
  TXSB: { label: 'S.D. Texas' },
  NJB: { label: 'D. New Jersey' },
  TXNB: { label: 'N.D. Texas' },
  VAEB: { label: 'E.D. Virginia' },
  ILNB: { label: 'N.D. Illinois' },
  CACB: { label: 'C.D. California' },
  FLSB: { label: 'S.D. Florida' },
  GANB: { label: 'N.D. Georgia' },
  MOEB: { label: 'E.D. Missouri' },
  AZB: { label: 'D. Arizona' },
  WAWB: { label: 'W.D. Washington' },
  MAB: { label: 'D. Massachusetts' },
};

const NATIONWIDE_COURTS = Object.keys(COURTS);

const COURT_SCOPES = {
  nationwide: { label: 'All Courts — Nationwide (AACER)', courts: NATIONWIDE_COURTS },
  dede: { label: 'D. Delaware', courts: ['DEDE'] },
  nysb: { label: 'S.D. New York', courts: ['NYSB'] },
  txsb: { label: 'S.D. Texas', courts: ['TXSB'] },
};

const CHAPTERS = {
  all: 'All Chapters',
  7: 'Chapter 7',
  11: 'Chapter 11',
  13: 'Chapter 13',
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Epiq AACER bankruptcy case search request:',
  '- Service: `app/services/verticals/37b90289.js`',
  '- Route: `app/routes/verticals/37b90289.js`',
  '- Page: `app/public/verticals/37b90289.html` (served at `/epiq`)',
  '- Test: `tests/37b90289-case-search.test.js`',
  '',
  'Nationwide case searches (the default court scope) succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `collectCourtDockets` and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-court docket latency.',
  'Preserve the response payload for every court scope, including AACER court priority ordering of results and court summaries.',
  'Run `npx jest tests/37b90289-case-search.test.js --runInBand` and `npm run lint`.',
  'Verify the default nationwide search at `/epiq` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashDocketQuery(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function queryCourtDocket(courtCode, debtorName, chapter) {
  const [min, max] = DOCKET_QUERY_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const hash = hashDocketQuery(`${courtCode}:${debtorName.toLowerCase()}`);
  const courtLabel = COURTS[courtCode].label;
  const suffixes = ['Holdings, LLC', 'Management, LLC', 'Hospitality, LLC', 'Operating Co.', 'Inc.'];
  const chapterValues = ['7', '11', '13'];
  const statuses = ['Open', 'Plan Confirmed', 'Claims Bar Date Set', 'Closed'];
  const caseCount = 1 + (hash % 2);
  const matches = [];

  for (let index = 0; index < caseCount; index += 1) {
    const caseHash = (hash + Math.imul(index, 0x9e3779b9)) >>> 0;
    const caseYear = 24 + (caseHash % 3);
    let caseNumberSuffix = 10000 + ((caseHash >>> 4) % 89999);
    while (matches.some((match) => match.caseNumber === `${caseYear}-${caseNumberSuffix}`)) {
      caseNumberSuffix = 10000 + ((caseNumberSuffix - 9999) % 89999);
    }
    const caseNumber = `${caseYear}-${caseNumberSuffix}`;
    const caseChapter = chapterValues[(caseHash >>> 8) % chapterValues.length];
    const startDate = Date.UTC(2024, 0, 1);
    const filedDate = new Date(startDate + ((caseHash >>> 12) % 1096) * 86400000)
      .toISOString()
      .slice(0, 10);
    const match = {
      court: courtCode,
      courtLabel,
      caseNumber,
      debtor: `${debtorName} ${suffixes[(caseHash >>> 16) % suffixes.length]}`,
      chapter: caseChapter,
      filedDate,
      status: statuses[(caseHash >>> 20) % statuses.length],
      claimsAgent: caseChapter === '11' ? 'Epiq Corporate Restructuring' : 'Chapter Trustee',
    };

    if (chapter === 'all' || match.chapter === chapter) matches.push(match);
  }

  return { court: courtCode, courtLabel, matches };
}

/**
 * Query court dockets in AACER priority order; results are listed in that order.
 */
async function collectCourtDockets(courts, debtorName, chapter) {
  const results = [];
  for (const court of courts) {
    results.push(await queryCourtDocket(court, debtorName, chapter));
  }
  return results;
}

function validateSearchRequest(data) {
  const validDebtorName = typeof data.debtorName === 'string'
    && data.debtorName.length >= 2
    && data.debtorName.length <= 80;
  const validCourtScope = Object.hasOwn(COURT_SCOPES, data.courtScope);
  const validChapter = Object.hasOwn(CHAPTERS, data.chapter);

  if (!validDebtorName || !validCourtScope || !validChapter) {
    const error = new Error('Enter a valid debtor name and court scope.');
    error.name = 'ValidationError';
    error.code = 'CASE_SEARCH_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, courtsQueried, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      court_scope: data.courtScope,
      chapter: data.chapter,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      courtsQueried,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/37b90289.js — collectCourtDockets',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Epiq AACER Case Search',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '37b90289',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'court_scope', value: data.courtScope },
      { key: 'chapter', value: data.chapter },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      courtsQueried,
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
    logger.error('Failed to create Devin session for Epiq case-search latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function searchCases(data = {}) {
  const startTime = Date.now();
  const searchId = `EPIQ-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    debtorName: String(requestData.debtorName ?? '').trim(),
    courtScope: String(requestData.courtScope ?? 'nationwide').trim().toLowerCase(),
    chapter: String(requestData.chapter ?? 'all').trim(),
  };

  validateSearchRequest(normalized);

  const courtScope = COURT_SCOPES[normalized.courtScope];
  logger.info('Searching Epiq AACER bankruptcy dockets', {
    searchId,
    debtorName: normalized.debtorName,
    courtScope: normalized.courtScope,
    chapter: normalized.chapter,
    service: SERVICE,
    route: ROUTE,
  });

  const courtResults = await collectCourtDockets(
    courtScope.courts,
    normalized.debtorName,
    normalized.chapter,
  );
  const results = courtResults.flatMap((courtResult) => courtResult.matches);
  const durationMs = Date.now() - startTime;

  incrementMetric('case_search.success', {
    route: ROUTE,
    court_scope: normalized.courtScope,
    chapter: normalized.chapter,
  });
  recordTiming('case_search.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('case_search.latency_budget_breach', {
      route: ROUTE,
      court_scope: normalized.courtScope,
      chapter: normalized.chapter,
    });
    logger.warn('Epiq AACER case search exceeded latency budget', {
      searchId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      courtsQueried: courtResults.length,
      courtScope: normalized.courtScope,
      chapter: normalized.chapter,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: searchId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      courtsQueried: courtResults.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    searchId,
    debtorName: normalized.debtorName,
    courtScope: {
      key: normalized.courtScope,
      label: courtScope.label,
    },
    chapter: {
      key: normalized.chapter,
      label: CHAPTERS[normalized.chapter],
    },
    courtsQueried: courtResults.length,
    totalMatches: results.length,
    courtSummaries: courtResults.map((courtResult) => ({
      court: courtResult.court,
      courtLabel: courtResult.courtLabel,
      matchCount: courtResult.matches.length,
    })),
    results,
    durationMs,
  };
}

module.exports = {
  searchCases,
  queryCourtDocket,
  COURTS,
  NATIONWIDE_COURTS,
  COURT_SCOPES,
  CHAPTERS,
  DOCKET_QUERY_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
