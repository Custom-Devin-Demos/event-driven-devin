/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  claimLatencyAlert,
  latencyAlertKey,
  releaseLatencyAlert,
  startedInvestigation,
} = require('../latency-alert-cooldown');

const SLACK_MEMBER_ID = process.env.CERENCE_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-ea983805-site-search';
const ROUTE = '/api/ea983805/search';

const LATENCY_SLO = { budgetMs: 3000 };
const INDEX_QUERY_POLICY = { latencyMs: [450, 550] };
const MAX_RESULTS = 10;
const DEFAULT_QUERY = 'voice';

const CONTENT_INDEXES = [
  { id: 'in-the-news', label: 'In the News', tag: 'in the news' },
  { id: 'blog', label: 'Blog', tag: 'blog' },
  { id: 'press-releases', label: 'Press Releases', tag: 'press releases' },
  { id: 'platforms', label: 'Platforms', tag: 'platform' },
  { id: 'products', label: 'Products', tag: 'product' },
  { id: 'industries', label: 'Industries', tag: 'industry' },
  { id: 'services', label: 'Services', tag: 'service' },
  { id: 'events', label: 'Events', tag: 'event' },
  { id: 'webinars', label: 'Webinars', tag: 'webinar' },
  { id: 'podcasts', label: 'Podcasts', tag: 'podcast' },
  { id: 'customer-stories', label: 'Customer Stories', tag: 'customer story' },
  { id: 'investors', label: 'Investors', tag: 'investors' },
  { id: 'careers', label: 'Careers', tag: 'careers' },
  { id: 'resources', label: 'Resources', tag: 'resource' },
];

const SCOPES = [
  { id: 'all', label: 'All content' },
  ...CONTENT_INDEXES.map(({ id, label }) => ({ id, label })),
];

const CONTENT = [
  {
    rank: 1, index: 'in-the-news', source: 'Voice Tech Podcast', external: true,
    title: 'Voice UX for Self-Driving Cars – Adam Emfield, Cerence – Voice Tech Podcast ep.046',
    url: 'https://voicetechpodcast.com/episodes/voice-ux-for-self-driving-cars-adam-emfield-cerence-voice-tech-podcast-ep-046/',
  },
  {
    rank: 2, index: 'in-the-news', source: 'AutoLab (China)', external: true,
    title: 'Voice Interaction + Large Model, When will more Human-like In-Car Voice Interaction Come?',
    url: 'https://mp.weixin.qq.com/s/5_KfGIkbUU4DDJ3i68Uv4A',
  },
  {
    rank: 3, index: 'in-the-news', source: 'Voicebot.ai', external: true,
    title: 'Voice Year in Review 2021 The Enterprise Edition – Voicebot Podcast Ep 239',
    url: 'https://voicebot.ai/2021/12/27/voice-year-in-review-2021-the-enterprise-edition-voicebot-podcast-ep-239/',
  },
  {
    rank: 4, index: 'in-the-news', source: 'Voicebot.ai', external: true,
    title: 'Voice Assistant Adoption in the Car Data Review with Cerence CEO Sanjay Dhawan – Voicebot Podcast Ep 144',
    url: 'https://voicebot.ai/2020/04/10/voice-assistant-adoption-in-the-car-data-review-with-cerence-ceo-sanjay-dhawan-voicebot-podcast-ep-144/',
  },
  {
    rank: 5, index: 'in-the-news', source: 'PYMNTS.com', external: true,
    title: 'Voice Assistants Help Truckers Take Hassle out of Record-Keeping',
    url: 'https://www.pymnts.com/voice-activation/2022/voice-assistants-help-truckers-take-hassle-out-of-record-keeping/',
  },
  {
    rank: 6, index: 'in-the-news', source: 'Auto Futures', external: true,
    title: 'Voice is Just The Beginning – How Cerence is Creating The In-Car Assistants of The Future',
    url: 'https://www.autofutures.tv/topics/voice-is-just-the-beginning---how-cerence-is-creating-the-in-car-assistants-of-the-future/s/c2c1dda0-b6c6-4606-8f93-e947992f184e',
  },
  {
    rank: 7, index: 'in-the-news', source: 'PYMNTS.com', external: true,
    title: 'Voice AI Takes the Wheel Transforming Connected Car Experiences',
    url: 'https://www.pymnts.com/artificial-intelligence-2/2024/voice-ai-takes-the-wheel-transforming-connected-car-experiences/',
  },
  {
    rank: 8, index: 'blog', source: '', external: false,
    title: 'Voice is the New Infrastructure',
    url: 'https://www.cerence.com/newsroom/blog/voice-is-infrastructure',
  },
  {
    rank: 9, index: 'blog', source: '', external: false,
    title: 'Diversity in Voice Assistants: Adjusting Tone and Timbre to Deliver a Genderless Voice',
    url: 'https://www.cerence.com/newsroom/blog/diversity-in-voice-assistants-adjusting-tone-and-timbre-to-deliver-a-genderless-voice',
  },
  {
    rank: 10, index: 'in-the-news', source: 'Voicebot.ai', external: true,
    title: 'Cerence Reader Makes Earnings Call and Voice Tech History with Cloned Voices of CEO and CFO Presenting to Analysts',
    url: 'https://voicebot.ai/2020/11/20/cerence-reader-makes-earnings-call-and-voice-tech-history-with-cloned-voices-of-ceo-and-cfo-presenting-to-analysts/',
  },
  {
    rank: 11, index: 'in-the-news', source: 'Voicebot.ai', external: true,
    title: 'Sanjay Dhawan CEO of Cerence Talks About Voice and AI in the Car – Voicebot Podcast Ep 120',
    url: 'https://voicebot.ai/2019/10/28/sanjay-dhawan-ceo-of-cerence-talks-about-voice-and-ai-in-the-car-voicebot-podcast-ep-120/',
  },
  {
    rank: 12, index: 'blog', source: '', external: false,
    title: 'From “Voice in the Car” to “Voice of the Car:” How In-Car Voice Assistants Have Become the New Normal',
    url: 'https://www.cerence.com/newsroom/blog/from-voice-in-the-car-to-voice-of-the-car-how-in-car-voice-assistants-have-become-the-new-normal',
  },
  {
    rank: 13, index: 'press-releases', source: '', external: false,
    title: 'Cerence and Vivoka Expand Collaboration to Deliver Embedded Voice AI for Industrial Markets Worldwide',
    url: 'https://www.cerence.com/newsroom/press-releases/cerence-and-vivoka-expand-collaboration-to-deliver-embedded-voice-ai-for-industrial-markets-worldwide',
  },
  {
    rank: 14, index: 'press-releases', source: '', external: false, keywords: 'voice edge conversational',
    title: 'Cerence AI and SiMa.ai Partner to Power Next-Gen Conversational AI at the Edge',
    url: 'https://www.cerence.com/newsroom/press-releases/cerence-ai-and-simaai-partner-to-power-next-gen-conversational-ai-at-the-edge',
  },
  {
    rank: 15, index: 'press-releases', source: '', external: false, keywords: 'voice agent microsoft copilot',
    title: 'Cerence AI Develops Mobile Work AI Agent, Integrating Microsoft 365 Copilot Into Cars to Enable Safer, Smarter Work on the Go',
    url: 'https://www.cerence.com/newsroom/press-releases/cerence-ai-develops-mobile-work-ai-agent-integrating-microsoft-365-copilot-into-cars-to-enable-safer-smarter-work-on-the-go',
  },
  {
    rank: 16, index: 'platforms', source: 'Level up automotive voice assistance with hybrid agentic AI', external: false,
    title: 'Cerence xUI®',
    url: 'https://www.cerence.com/platforms/cerence-xui',
    keywords: 'voice assistant agentic hybrid platform',
  },
  {
    rank: 17, index: 'platforms', source: 'Best-in-class natural voice assistance on every journey', external: false,
    title: 'Cerence Assistant Experience',
    url: 'https://www.cerence.com/platforms/cerence-assistant',
    keywords: 'voice assistant platform',
  },
  {
    rank: 18, index: 'products', source: 'AI-enhanced audio and noise processing for crystal-clear sound', external: false,
    title: 'Audio AI',
    url: 'https://www.cerence.com/products/audio-ai',
    keywords: 'voice audio speech signal enhancement in-car communication',
  },
  {
    rank: 19, index: 'products', source: 'Bring human-like communication to life through natural speech interactions', external: false,
    title: 'Speech Input & Output',
    url: 'https://www.cerence.com/products/speech-input-output',
    keywords: 'voice speech tts asr',
  },
  {
    rank: 20, index: 'industries', source: 'Power smarter hauls with AI-Driven Voice Assistance', external: false,
    title: 'Trucks',
    url: 'https://www.cerence.com/industries/trucks',
    keywords: 'voice truck fleet',
  },
  {
    rank: 21, index: 'industries', source: 'Empower riders with hands-free and voice-enabled assistance', external: false,
    title: 'Two-Wheelers',
    url: 'https://www.cerence.com/industries/two-wheelers',
    keywords: 'voice motorcycle',
  },
  {
    rank: 22, index: 'products', source: 'Extend voice experiences with purpose‑built AI agents', external: false,
    title: 'AI Agents',
    url: 'https://www.cerence.com/products/ai-agents',
    keywords: 'voice agents dealer assist',
  },
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Cerence AI site search:',
  '- Service: `app/services/verticals/ea983805.js`',
  '- Route: `app/routes/verticals/ea983805.js`',
  '- Page: `app/public/verticals/ea983805.html` (served at `/cerence` and `/cerence/search`)',
  '- Test: `tests/ea983805-site-search.test.js`',
  '',
  'Default "All content" searches (e.g. `voice`) succeed but take ~7s, breaching the 3000ms latency budget and triggering a Devin session.',
  'Find the root cause in `searchContentIndexes` and `queryContentIndex`. Preserve the latency budget, breach alert, simulated per-call latency, response shape, and result ordering (relevance rank, top 10).',
  'Fix the sequential content-index queries with `Promise.all` while preserving index order.',
  'Run `npx jest tests/ea983805-site-search.test.js --runInBand` and `npm run lint`.',
  'Verify the default search returns in under 3 seconds.',
  'Open a fix pull request against `main`.',
].join('\n');

function createValidationError(message, code, requestId) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  error.requestId = requestId;
  return error;
}

function validateSearch(data, requestId) {
  if (!data.q) {
    throw createValidationError('Enter a search term.', 'QUERY_REQUIRED', requestId);
  }
  if (data.q.length > 100) {
    throw createValidationError('Search terms must be 100 characters or fewer.', 'QUERY_TOO_LONG', requestId);
  }
  if (!SCOPES.some(({ id }) => id === data.scope)) {
    throw createValidationError('Select a valid content type.', 'INVALID_SCOPE', requestId);
  }
}

function matches(doc, terms) {
  const haystack = `${doc.title} ${doc.source} ${doc.keywords || ''}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

async function queryContentIndex(index, terms) {
  const [min, max] = INDEX_QUERY_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  return CONTENT.filter((doc) => doc.index === index.id && matches(doc, terms));
}

async function searchContentIndexes(scope, terms) {
  if (scope !== 'all') {
    const index = CONTENT_INDEXES.find(({ id }) => id === scope);
    return {
      hits: await queryContentIndex(index, terms),
      indexesQueried: 1,
    };
  }

  const hits = [];
  for (const index of CONTENT_INDEXES) {
    hits.push(...await queryContentIndex(index, terms));
  }

  return {
    hits,
    indexesQueried: CONTENT_INDEXES.length,
  };
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, indexesQueried, data,
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
      indexesQueried,
      query: data.q,
    },
  });

  const alertKey = latencyAlertKey('ea983805', data.devinOrgId);
  const claim = claimLatencyAlert(alertKey);
  if (!claim) {
    logger.info('Cerence site search latency breach alert suppressed by cooldown', { requestId, durationMs });
    return;
  }

  Promise.resolve(createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/ea983805.js — searchContentIndexes',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Cerence AI Site Search',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'ea983805',
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
      indexesQueried,
      query: data.q,
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
  })).then((result) => {
    if (!startedInvestigation(result)) releaseLatencyAlert(alertKey, claim);
  }).catch((alertError) => {
    releaseLatencyAlert(alertKey, claim);
    logger.error('Failed to create Devin session for Cerence site search latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function searchSite(data = {}) {
  const startTime = Date.now();
  const requestId = `CER-SRCH-${uuidv4().slice(0, 6).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    q: String(requestData.q === undefined || requestData.q === null ? '' : requestData.q).trim(),
    scope: requestData.scope === undefined ? 'all' : requestData.scope,
  };

  validateSearch(normalized, requestId);

  const terms = normalized.q.toLowerCase().split(/\s+/).filter(Boolean);

  logger.info('Running Cerence site search', {
    requestId,
    query: normalized.q,
    scope: normalized.scope,
    service: SERVICE,
    route: ROUTE,
  });

  const search = await searchContentIndexes(normalized.scope, terms);
  const durationMs = Date.now() - startTime;

  incrementMetric('site_search.success', { route: ROUTE, scope: normalized.scope });
  recordTiming('site_search.latency', durationMs, { route: ROUTE });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('site_search.latency_budget_breach', { route: ROUTE, scope: normalized.scope });
    logger.warn('Cerence site search exceeded latency budget — triggering Devin', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      indexesQueried: search.indexesQueried,
      scope: normalized.scope,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      indexesQueried: search.indexesQueried,
      data: normalized,
    }));
  }

  const ranked = [...search.hits].sort((a, b) => a.rank - b.rank);
  const scope = SCOPES.find(({ id }) => id === normalized.scope);

  return {
    success: true,
    requestId,
    query: normalized.q,
    scope: normalized.scope,
    scopeLabel: scope.label,
    totalMatches: ranked.length,
    results: ranked.slice(0, MAX_RESULTS).map((doc) => ({
      title: doc.title,
      url: doc.url,
      source: doc.source,
      external: doc.external,
      type: CONTENT_INDEXES.find(({ id }) => id === doc.index).tag,
    })),
    timing: {
      totalMs: durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      indexesQueried: search.indexesQueried,
    },
  };
}

module.exports = {
  searchSite,
  queryContentIndex,
  searchContentIndexes,
  SERVICE,
  ROUTE,
  LATENCY_SLO,
  INDEX_QUERY_POLICY,
  CONTENT_INDEXES,
  CONTENT,
  SCOPES,
  MAX_RESULTS,
  DEFAULT_QUERY,
  REMEDIATION_DIRECTIVE,
};
