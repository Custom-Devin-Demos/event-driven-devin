/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.SEI_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-fd043af6-program-match';
const ROUTE = '/api/fd043af6/program-match';

const LATENCY_SLO = { budgetMs: 3000 };
const CATALOG_QUERY_POLICY = { latencyMs: [480, 600] };

const FOCUS_AREAS = {
  business: 'Business & Leadership',
  technology: 'Technology & Data',
  healthcare: 'Healthcare & Nursing',
  education: 'Education & Human Services',
};

const INSTITUTIONS = {
  strayer: {
    label: 'Strayer University',
    catalog: {
      business: [
        {
          program: 'BS Business Administration',
          credential: "Bachelor's",
          format: 'Online',
          annualTuitionUsd: 15250,
        },
        {
          program: 'Master of Business Administration',
          credential: "Master's",
          format: 'Online',
          annualTuitionUsd: 17400,
        },
      ],
      technology: [
        {
          program: 'BS Information Technology',
          credential: "Bachelor's",
          format: 'Online',
          annualTuitionUsd: 15250,
        },
      ],
      healthcare: [
        {
          program: 'MS Health Services Administration',
          credential: "Master's",
          format: 'Online',
          annualTuitionUsd: 16500,
        },
      ],
      education: [
        {
          program: 'MEd Curriculum & Instruction',
          credential: "Master's",
          format: 'Online',
          annualTuitionUsd: 14200,
        },
      ],
    },
  },
  capella: {
    label: 'Capella University',
    catalog: {
      business: [
        {
          program: 'BS Business',
          credential: "Bachelor's",
          format: 'FlexPath',
          annualTuitionUsd: 14000,
        },
        {
          program: 'MBA',
          credential: "Master's",
          format: 'FlexPath',
          annualTuitionUsd: 16500,
        },
      ],
      technology: [
        {
          program: 'BS Information Technology',
          credential: "Bachelor's",
          format: 'FlexPath',
          annualTuitionUsd: 14500,
        },
        {
          program: 'MS Analytics',
          credential: "Master's",
          format: 'Online',
          annualTuitionUsd: 17200,
        },
      ],
      healthcare: [
        {
          program: 'RN-to-BSN',
          credential: "Bachelor's",
          format: 'FlexPath',
          annualTuitionUsd: 11800,
        },
        {
          program: 'MS Nursing',
          credential: "Master's",
          format: 'FlexPath',
          annualTuitionUsd: 15800,
        },
      ],
      education: [
        {
          program: 'EdD Education',
          credential: 'Doctorate',
          format: 'Online',
          annualTuitionUsd: 18900,
        },
        {
          program: 'MS Education',
          credential: "Master's",
          format: 'FlexPath',
          annualTuitionUsd: 14900,
        },
      ],
    },
  },
  jwmi: {
    label: 'Jack Welch Management Institute',
    catalog: {
      business: [
        {
          program: 'Jack Welch MBA',
          credential: "Master's",
          format: 'Online',
          annualTuitionUsd: 19800,
        },
        {
          program: 'Executive Certificate in Leadership',
          credential: 'Certificate',
          format: 'Online',
          annualTuitionUsd: 7800,
        },
      ],
    },
  },
  sophia: {
    label: 'Sophia Learning',
    catalog: {
      business: [
        {
          program: 'Business Communication',
          credential: 'Certificate',
          format: 'Online',
          annualTuitionUsd: 1200,
        },
      ],
      technology: [
        {
          program: 'Introduction to Programming',
          credential: 'Certificate',
          format: 'Online',
          annualTuitionUsd: 1200,
        },
      ],
      healthcare: [
        {
          program: 'Human Biology',
          credential: 'Certificate',
          format: 'Online',
          annualTuitionUsd: 1100,
        },
      ],
      education: [
        {
          program: 'Introduction to Psychology',
          credential: 'Certificate',
          format: 'Online',
          annualTuitionUsd: 1100,
        },
      ],
    },
  },
  workforce_edge: {
    label: 'Workforce Edge',
    catalog: {
      business: [
        {
          program: 'Project Management Certificate',
          credential: 'Certificate',
          format: 'Online',
          annualTuitionUsd: 3600,
        },
      ],
      healthcare: [
        {
          program: 'Medical Billing & Coding Certificate',
          credential: 'Certificate',
          format: 'Online',
          annualTuitionUsd: 3400,
        },
      ],
    },
  },
  hackbright: {
    label: 'Hackbright Academy',
    catalog: {
      technology: [
        {
          program: 'Software Engineering Bootcamp',
          credential: 'Bootcamp',
          format: 'Online',
          annualTuitionUsd: 12900,
        },
      ],
    },
  },
  devmountain: {
    label: 'Devmountain',
    catalog: {
      technology: [
        {
          program: 'Web Development Bootcamp',
          credential: 'Bootcamp',
          format: 'Hybrid',
          annualTuitionUsd: 9900,
        },
        {
          program: 'UX Design Bootcamp',
          credential: 'Bootcamp',
          format: 'Online',
          annualTuitionUsd: 8900,
        },
      ],
    },
  },
  skills_pathways: {
    label: 'Skills Pathways',
    catalog: {
      business: [
        {
          program: 'Frontline Leadership Certificate',
          credential: 'Certificate',
          format: 'Hybrid',
          annualTuitionUsd: 2900,
        },
      ],
      healthcare: [
        {
          program: 'Patient Care Technician Certificate',
          credential: 'Certificate',
          format: 'Hybrid',
          annualTuitionUsd: 3100,
        },
      ],
    },
  },
  degrees_at_work: {
    label: 'Degrees@Work',
    catalog: {
      business: [
        {
          program: 'BS Organizational Leadership',
          credential: "Bachelor's",
          format: 'Online',
          annualTuitionUsd: 9800,
        },
      ],
      education: [
        {
          program: 'BA Liberal Studies',
          credential: "Bachelor's",
          format: 'Online',
          annualTuitionUsd: 9400,
        },
      ],
    },
  },
  torrens: {
    label: 'Torrens University Australia',
    catalog: {
      business: [
        {
          program: 'Bachelor of Business',
          credential: "Bachelor's",
          format: 'Hybrid',
          annualTuitionUsd: 18400,
        },
      ],
      technology: [
        {
          program: 'Bachelor of Software Engineering',
          credential: "Bachelor's",
          format: 'Hybrid',
          annualTuitionUsd: 19600,
        },
      ],
      healthcare: [
        {
          program: 'Bachelor of Nursing',
          credential: "Bachelor's",
          format: 'Hybrid',
          annualTuitionUsd: 20100,
        },
      ],
      education: [
        {
          program: 'Graduate Certificate in Education',
          credential: 'Certificate',
          format: 'Online',
          annualTuitionUsd: 11200,
        },
      ],
    },
  },
  mds: {
    label: 'Media Design School',
    catalog: {
      technology: [
        {
          program: 'Bachelor of Creative Technologies',
          credential: "Bachelor's",
          format: 'Hybrid',
          annualTuitionUsd: 17500,
        },
        {
          program: 'Game Development Bootcamp',
          credential: 'Bootcamp',
          format: 'Hybrid',
          annualTuitionUsd: 13400,
        },
      ],
    },
  },
  think: {
    label: 'Think Education',
    catalog: {
      business: [
        {
          program: 'Diploma of Business',
          credential: 'Associate',
          format: 'Hybrid',
          annualTuitionUsd: 12800,
        },
      ],
      healthcare: [
        {
          program: 'Diploma of Nursing',
          credential: 'Associate',
          format: 'Hybrid',
          annualTuitionUsd: 13600,
        },
      ],
      education: [
        {
          program: 'Diploma of Community Services',
          credential: 'Associate',
          format: 'Online',
          annualTuitionUsd: 12100,
        },
      ],
    },
  },
  strayer_online: {
    label: 'Strayer University Online',
    catalog: {
      business: [
        {
          program: 'AA Business Administration',
          credential: 'Associate',
          format: 'Online',
          annualTuitionUsd: 13900,
        },
      ],
      technology: [
        {
          program: 'AS Information Systems',
          credential: 'Associate',
          format: 'Online',
          annualTuitionUsd: 13900,
        },
      ],
    },
  },
};

const NETWORKS = {
  all: {
    label: 'All SEI institutions (recommended)',
    institutions: [
      'strayer',
      'capella',
      'jwmi',
      'sophia',
      'workforce_edge',
      'hackbright',
      'devmountain',
      'skills_pathways',
      'degrees_at_work',
      'torrens',
      'mds',
      'think',
      'strayer_online',
    ],
  },
  strayer: {
    label: 'Strayer University only',
    institutions: ['strayer'],
  },
  capella: {
    label: 'Capella University only',
    institutions: ['capella'],
  },
  sophia: {
    label: 'Sophia Learning only',
    institutions: ['sophia'],
  },
  hackbright: {
    label: 'Hackbright Academy only',
    institutions: ['hackbright'],
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Strategic Education program match request:',
  '- Service: `app/services/verticals/fd043af6.js`',
  '- Route: `app/routes/verticals/fd043af6.js`',
  '- Page: `app/public/verticals/fd043af6.html` (served at `/strategiced`)',
  '- Test: `tests/fd043af6-program-match.test.js`',
  '',
  "Program matches for the default 'All SEI institutions' network succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.",
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated catalog latency.',
  'Preserve the response payload for every network, including institution order and the recommendation tie-break.',
  'Run `npx jest tests/fd043af6-program-match.test.js --runInBand` and `npm run lint`.',
  'Verify the default program match at `/strategiced` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

async function queryInstitutionCatalog(institutionKey, focusArea) {
  const [min, max] = CATALOG_QUERY_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const institution = INSTITUTIONS[institutionKey];
  return {
    institutionKey,
    institution: institution.label,
    programs: institution.catalog[focusArea] || [],
  };
}

/**
 * Query institution catalogs in partner-network priority order;
 * recommendation tie-breaks by that order.
 */
async function collectCatalogMatches(focusArea, institutionKeys) {
  const matches = [];
  for (const institutionKey of institutionKeys) {
    matches.push(await queryInstitutionCatalog(institutionKey, focusArea));
  }
  return matches;
}

function selectRecommendation(matches) {
  let best = null;
  for (const match of matches) {
    for (const program of match.programs) {
      if (!best || program.annualTuitionUsd < best.annualTuitionUsd) {
        best = {
          institutionKey: match.institutionKey,
          institution: match.institution,
          program: program.program,
          credential: program.credential,
          format: program.format,
          annualTuitionUsd: program.annualTuitionUsd,
        };
      }
    }
  }
  return best;
}

function validateMatchRequest(data) {
  const validCompany = typeof data.company === 'string'
    && data.company.trim().length > 0
    && data.company.trim().length <= 120;
  const validEmail = typeof data.email === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email);
  const validTeamSize = Number.isInteger(data.teamSize)
    && data.teamSize >= 1
    && data.teamSize <= 100000;
  const validFocusArea = Object.hasOwn(FOCUS_AREAS, data.focusArea);
  const validNetwork = Object.hasOwn(NETWORKS, data.network);

  if (!validCompany || !validEmail || !validTeamSize || !validFocusArea || !validNetwork) {
    const error = new Error('Enter valid program match details.');
    error.name = 'ValidationError';
    error.code = 'PROGRAM_MATCH_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, institutionsSearched, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      focus_area: data.focusArea,
      network: data.network,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      institutionsSearched,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/fd043af6.js — collectCatalogMatches',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Strategic Education Program Match',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'fd043af6',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'focus_area', value: data.focusArea },
      { key: 'network', value: data.network },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      institutionsSearched,
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
    logger.error('Failed to create Devin session for Strategic Education program-match latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function matchPrograms(data = {}) {
  const startTime = Date.now();
  const matchId = `SEI-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    company: String(requestData.company === undefined ? 'Acme Logistics' : requestData.company).trim(),
    email: String(requestData.email === undefined ? 'benefits@acme.example' : requestData.email).trim(),
    teamSize: Number(requestData.teamSize === undefined ? 250 : requestData.teamSize),
    focusArea: String(requestData.focusArea || 'business').trim().toLowerCase(),
    network: String(requestData.network || 'all').trim().toLowerCase(),
  };

  validateMatchRequest(normalized);

  const network = NETWORKS[normalized.network];

  logger.info('Matching Strategic Education programs', {
    matchId,
    company: normalized.company,
    teamSize: normalized.teamSize,
    focusArea: normalized.focusArea,
    network: normalized.network,
    service: SERVICE,
    route: ROUTE,
  });

  const catalogMatches = await collectCatalogMatches(normalized.focusArea, network.institutions);
  const matches = catalogMatches.filter((match) => match.programs.length > 0);
  const recommendation = selectRecommendation(matches);
  const totalPrograms = matches.reduce((total, match) => total + match.programs.length, 0);
  const estimatedEligibleLearners = Math.max(1, Math.round(normalized.teamSize * 0.12));
  const durationMs = Date.now() - startTime;

  incrementMetric('program_match.success', {
    route: ROUTE,
    focusArea: normalized.focusArea,
    network: normalized.network,
  });
  recordTiming('program_match.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('program_match.latency_budget_breach', {
      route: ROUTE,
      focusArea: normalized.focusArea,
      network: normalized.network,
    });
    logger.warn('Strategic Education program match exceeded latency budget', {
      matchId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      institutionsSearched: catalogMatches.length,
      focusArea: normalized.focusArea,
      network: normalized.network,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: matchId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      institutionsSearched: catalogMatches.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    matchId,
    company: normalized.company,
    teamSize: normalized.teamSize,
    focusArea: {
      key: normalized.focusArea,
      label: FOCUS_AREAS[normalized.focusArea],
    },
    network: {
      key: normalized.network,
      label: network.label,
    },
    institutionsSearched: catalogMatches.length,
    totalPrograms,
    matches,
    recommendation,
    estimatedEligibleLearners,
    durationMs,
  };
}

module.exports = {
  matchPrograms,
  selectRecommendation,
  collectCatalogMatches,
  FOCUS_AREAS,
  INSTITUTIONS,
  NETWORKS,
  CATALOG_QUERY_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
