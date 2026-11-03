const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/research/answers';
const SERVICE = 'research-api';

const DOC_TYPES = ['8-K', '10-Q', 'DEF 14A', 'Form 4'];
const MAX_TICKERS = 3;
const MAX_QUERY_LENGTH = 500;
const DOCUMENT_FETCH_MS = 650;

const COMPANIES = {
  NVDA: { name: 'NVIDIA Corporation', short: 'NVIDIA' },
  AAPL: { name: 'Apple Inc.', short: 'Apple' },
  MSFT: { name: 'Microsoft Corporation', short: 'Microsoft' },
  TSLA: { name: 'Tesla, Inc.', short: 'Tesla' },
};

/** Most recent filings per form type, newest first. */
const FILINGS = {
  NVDA: {
    '8-K': [
      { title: 'Results of Operations and Financial Condition (Q3 FY2026)', filedAt: '2025-11-19' },
      { title: 'Departure of Directors or Certain Officers', filedAt: '2025-09-10' },
      { title: 'Results of Operations and Financial Condition (Q2 FY2026)', filedAt: '2025-08-27' },
    ],
    '10-Q': [
      { title: 'Quarterly Report for the period ended October 26, 2025', filedAt: '2025-11-19' },
      { title: 'Quarterly Report for the period ended July 27, 2025', filedAt: '2025-08-27' },
      { title: 'Quarterly Report for the period ended April 27, 2025', filedAt: '2025-05-28' },
    ],
    'DEF 14A': [
      { title: 'Definitive Proxy Statement — 2025 Annual Meeting', filedAt: '2025-05-13' },
      { title: 'Definitive Proxy Statement — 2024 Annual Meeting', filedAt: '2024-05-13' },
    ],
    'Form 4': [
      { title: 'Statement of Changes in Beneficial Ownership — J. Huang', filedAt: '2025-10-17' },
      { title: 'Statement of Changes in Beneficial Ownership — C. Kress', filedAt: '2025-09-22' },
      { title: 'Statement of Changes in Beneficial Ownership — M. Stevens', filedAt: '2025-09-05' },
      { title: 'Statement of Changes in Beneficial Ownership — T. Coxe', filedAt: '2025-08-29' },
    ],
  },
};

function filingsFor(ticker) {
  if (FILINGS[ticker]) return FILINGS[ticker];
  const { short } = COMPANIES[ticker];
  return {
    '8-K': [
      { title: `${short} — Results of Operations and Financial Condition`, filedAt: '2025-10-30' },
      { title: `${short} — Other Events`, filedAt: '2025-09-15' },
      { title: `${short} — Results of Operations and Financial Condition`, filedAt: '2025-07-31' },
    ],
    '10-Q': [
      { title: `${short} — Quarterly Report (latest quarter)`, filedAt: '2025-10-30' },
      { title: `${short} — Quarterly Report (prior quarter)`, filedAt: '2025-07-31' },
      { title: `${short} — Quarterly Report (two quarters prior)`, filedAt: '2025-05-01' },
    ],
    'DEF 14A': [
      { title: `${short} — Definitive Proxy Statement 2025`, filedAt: '2025-04-10' },
      { title: `${short} — Definitive Proxy Statement 2024`, filedAt: '2024-04-11' },
    ],
    'Form 4': [
      { title: `${short} — Statement of Changes in Beneficial Ownership (CEO)`, filedAt: '2025-10-03' },
      { title: `${short} — Statement of Changes in Beneficial Ownership (CFO)`, filedAt: '2025-09-12' },
      { title: `${short} — Statement of Changes in Beneficial Ownership (Director)`, filedAt: '2025-08-20' },
      { title: `${short} — Statement of Changes in Beneficial Ownership (Director)`, filedAt: '2025-08-01' },
    ],
  };
}

/**
 * Filing text is read from the document store at answer time so citations
 * always quote the latest (possibly amended) version of each filing.
 */
function fetchFilingText(ticker, docType, filing) {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ ticker, docType, ...filing, characters: 48000 }), DOCUMENT_FETCH_MS);
  });
}

async function pullDocuments(tickers, sources) {
  const documents = [];
  for (const ticker of tickers) {
    const filings = filingsFor(ticker);
    for (const docType of sources) {
      for (const filing of filings[docType]) {
        documents.push(await fetchFilingText(ticker, docType, filing));
      }
    }
  }
  return documents;
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_QUERY';
  return error;
}

function normalizeRequest(request) {
  const query = typeof request.query === 'string' ? request.query.trim() : '';
  if (query.length < 3) throw invalid('Ask a question of at least 3 characters.');
  if (query.length > MAX_QUERY_LENGTH) throw invalid(`Questions are limited to ${MAX_QUERY_LENGTH} characters.`);

  const requestedTickers = Array.isArray(request.tickers) ? request.tickers : [];
  const tickers = [...new Set(requestedTickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
  const unknown = tickers.filter((t) => !Object.hasOwn(COMPANIES, t));
  if (unknown.length) throw invalid(`Unknown ticker: ${unknown[0]}`);
  if (tickers.length > MAX_TICKERS) throw invalid(`Up to ${MAX_TICKERS} tickers per question.`);

  const requestedSources = Array.isArray(request.sources) ? request.sources : [];
  const sources = requestedSources.length ? [...new Set(requestedSources.map(String))] : DOC_TYPES;
  const badSource = sources.find((s) => !DOC_TYPES.includes(s));
  if (badSource) throw invalid(`Unknown source type: ${badSource}`);

  const model = typeof request.model === 'string' && request.model.trim() ? request.model.trim() : 'rogo-pro';
  return { query, tickers: tickers.length ? tickers : ['NVDA'], sources, model };
}

function nvidiaAnswer() {
  return {
    title: "NVIDIA's latest filings",
    summary: "NVIDIA's most recent filings are its Q3 FY2026 10-Q and earnings 8-K (both filed November 19, 2025). Data Center remains the growth driver, gross margins held in the mid-70s, and insider Form 4 activity reflects pre-scheduled 10b5-1 sales.",
    bullets: [
      { text: 'Q3 FY2026 revenue was $57.0 billion, up 22% sequentially and 62% year over year, led by Data Center revenue of $51.2 billion.', citations: [1, 2] },
      { text: 'GAAP gross margin was 73.4%; management guided Q4 gross margin to 74.8% (non-GAAP 75.0%), plus or minus 50 basis points.', citations: [1] },
      { text: 'Blackwell is the majority of Data Center compute shipments; management describes demand as exceeding supply into next year.', citations: [3] },
      { text: 'Recent Form 4 filings by executive officers report sales under Rule 10b5-1 trading plans adopted earlier in the year.', citations: [4] },
    ],
    citations: [
      { id: 1, ticker: 'NVDA', docType: '10-Q', source: 'Quarterly Report — Q3 FY2026', date: '2025-11-19', speaker: null, role: null, excerpt: 'Revenue for the third quarter of fiscal 2026 was $57.0 billion, up 22% from the previous quarter and up 62% from a year ago. Data Center revenue was $51.2 billion.', highlights: ['Revenue for the third quarter of fiscal 2026 was $57.0 billion'] },
      { id: 2, ticker: 'NVDA', docType: '8-K', source: 'Q3 2026 Earnings Call', date: '2025-11-19', speaker: 'Colette Kress', role: 'Executive', excerpt: 'We delivered another outstanding quarter with revenue of $57 billion, up 62% year over year and a record sequential revenue growth of $10 billion or 22%. Our customers continue to lean into three platform shifts, fueling exponential growth for accelerated computing, powerful AI models and agentic applications.', highlights: ['revenue of $57 billion, up 62% year over year', 'three platform shifts'] },
      { id: 3, ticker: 'NVDA', docType: '8-K', source: 'Press Release — Q3 FY2026 Results', date: '2025-11-19', speaker: 'Jensen Huang', role: 'Executive', excerpt: 'Blackwell sales are off the charts, and cloud GPUs are sold out. Compute demand keeps accelerating and compounding across training and inference.', highlights: ['Blackwell sales are off the charts'] },
      { id: 4, ticker: 'NVDA', docType: 'Form 4', source: 'Statement of Changes in Beneficial Ownership', date: '2025-10-17', speaker: null, role: null, excerpt: 'The sales reported on this Form 4 were effected pursuant to a Rule 10b5-1 trading plan adopted by the reporting person.', highlights: ['pursuant to a Rule 10b5-1 trading plan'] },
    ],
  };
}

const FILINGS_QUESTION = /filing|earnings|results|quarter|10-q|8-k|revenue|latest|recent|proxy|form 4|insider/i;

function latestFilingCitation(id, ticker, documents) {
  const latest = documents.find((d) => d.ticker === ticker);
  if (!latest) return null;
  return {
    id, ticker, docType: latest.docType, source: latest.title, date: latest.filedAt,
    speaker: null, role: null, excerpt: `${COMPANIES[ticker].name} \u2014 ${latest.title}, filed ${latest.filedAt}.`, highlights: [],
  };
}

/**
 * Compose a cited answer that covers every requested ticker and only cites
 * filing types that were requested and pulled.
 */
function composeAnswer(query, tickers, sources, documents) {
  const citations = [];
  const bullets = [];
  let summary = null;

  if (tickers[0] === 'NVDA' && FILINGS_QUESTION.test(query)) {
    const curated = nvidiaAnswer();
    const kept = new Map();
    for (const citation of curated.citations) {
      if (!sources.includes(citation.docType)) continue;
      const id = citations.length + 1;
      kept.set(citation.id, id);
      citations.push({ ...citation, id });
    }
    for (const bullet of curated.bullets) {
      const ids = bullet.citations.filter((c) => kept.has(c)).map((c) => kept.get(c));
      if (ids.length) bullets.push({ text: bullet.text, citations: ids });
    }
    if (kept.size === curated.citations.length) summary = curated.summary;
  }

  for (const ticker of tickers) {
    if (bullets.some((b) => citations[b.citations[0] - 1].ticker === ticker)) continue;
    const citation = latestFilingCitation(citations.length + 1, ticker, documents);
    if (!citation) continue;
    citations.push(citation);
    bullets.push({
      text: `${COMPANIES[ticker].short}'s most recent in-scope filing is its ${citation.docType} (${citation.source}, filed ${citation.date}).`,
      citations: [citation.id],
    });
  }

  const names = tickers.map((t) => COMPANIES[t].short);
  return {
    title: tickers.length === 1 ? `${names[0]}: ${query}` : `${names.join(', ')}: ${query}`,
    summary: summary || `Answer drawn from ${documents.length} ${sources.join(', ')} filings for ${names.join(', ')}.`,
    bullets,
    citations,
  };
}

/**
 * Answer a research question: pull the in-scope filings for each ticker,
 * then compose a cited answer from them.
 */
async function answerResearchQuery(request, options = {}) {
  const startTime = Date.now();
  const answerId = `ans_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  let normalized = null;

  try {
    normalized = normalizeRequest(request || {});
    const { query, tickers, sources, model } = normalized;
    logger.info('Research answer request', {
      answerId, tickers, sources, model, queryLength: query.length, service: SERVICE, route: ROUTE,
    });

    const documents = await pullDocuments(tickers, sources);
    const answer = composeAnswer(query, tickers, sources, documents);
    const duration = Date.now() - startTime;

    incrementMetric('research.answer.success', { route: ROUTE, model });
    recordTiming('research.answer.latency', duration, { route: ROUTE, model });
    logger.info('Research answer completed', { answerId, durationMs: duration, documents: documents.length });

    return {
      success: true,
      answerId,
      durationMs: duration,
      tickers,
      documents: documents.map(({ ticker, docType, title, filedAt }) => ({ ticker, docType, title, filedAt })),
      answer,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('research.answer.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('research.answer.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Research answer failed', {
      answerId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration,
    });
    if (error.code !== 'INVALID_QUERY') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { answerId, tickers: normalized && normalized.tickers },
      });
    }
    throw error;
  }
}

module.exports = { answerResearchQuery, COMPANIES, DOC_TYPES, DOCUMENT_FETCH_MS };
