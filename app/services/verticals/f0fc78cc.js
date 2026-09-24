const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'f0fc78cc-api';
const ROUTE = '/api/f0fc78cc/search';
const PAGE_SIZE = 10;
const TOTAL_LISTED = 412;

const MEDICATIONS = [
  { id: 'med-0001', name: 'Abacavir® (ziagen)', url: null, conditions: ['HIV'], conditionUrl: '/conditions/hiv', alternative: 'none', manufacturer: 'ViiV Healthcare' },
  { id: 'med-0002', name: 'Abraxane® (paclitaxel protein-bound particles for injectable suspension)', url: 'https://www.abraxane.com/', conditions: ['Cancer support', 'Breast cancer', 'Lung cancer', 'Pancreatic cancer'], conditionUrl: '/conditions/cancer-support', alternative: 'generic', manufacturer: 'Celgene Corporation' },
  { id: 'med-0003', name: 'Actemra® (tocilizumab)', url: 'https://www.actemra.com/', conditions: ['Rheumatoid arthritis', 'Juvenile idiopathic arthritis', 'Giant cell arteritis'], conditionUrl: '/conditions/rheumatoid-arthritis', alternative: 'none', manufacturer: 'Genentech USA, Inc.' },
  { id: 'med-0004', name: 'Acthar Gel® (repository corticotropin injection)', url: 'https://www.acthar.com/', conditions: ['Infantile spasms', 'Rheumatic disorders', 'Collagen diseases', 'Epilepsy', 'Neuroscience', 'Rheumatoid arthritis'], conditionUrl: '/conditions/epilepsy', alternative: 'none', manufacturer: 'Mallinckrodt Pharmaceuticals' },
  { id: 'med-0005', name: 'Actimmune® (interferon gamma-1b)', url: null, conditions: ['Osteopetrosis', 'Immune deficiency - Intravenous'], conditionUrl: null, alternative: 'none', manufacturer: 'Horizon Pharma, Inc.' },
  { id: 'med-0006', name: 'Adbry™ (tralokinumab-ldrm)', url: 'https://www.adbry.com/', conditions: ['Atopic Dermatitis', 'Allergy Asthma', 'Dermatology'], conditionUrl: '/conditions/asthma-allergy', alternative: 'none', manufacturer: 'LEO Pharma, Inc.' },
  { id: 'med-0007', name: 'Adcetris® (brentuximab vedotin)', url: 'https://www.adcetris.com/', conditions: ['Cancer support', 'Lymphoma'], conditionUrl: '/conditions/cancer-support', alternative: 'none', manufacturer: 'Seattle Genetics, Inc.' },
  { id: 'med-0008', name: 'Adcirca® (tadalafil)', url: null, conditions: ['Pulmonary arterial hypertension'], conditionUrl: '/conditions/pulmonary-arterial-hypertension', alternative: 'generic', manufacturer: 'Multiple Manufacturers' },
  { id: 'med-0009', name: 'Adempas® (riociguat)', url: 'https://www.adempas-us.com/', conditions: ['Pulmonary arterial hypertension'], conditionUrl: '/conditions/pulmonary-arterial-hypertension', alternative: 'none', manufacturer: 'Bayer' },
  { id: 'med-0010', name: 'Advate™ (antihemophilic factor [recombinant])', url: 'https://www.advate.com/', conditions: ['Bleeding disorders', 'Hemophilia A'], conditionUrl: '/conditions/hemophilia', alternative: 'none', manufacturer: 'Takeda Pharmaceuticals' },
  { id: 'med-0011', name: 'Afinitor® (everolimus)', url: 'https://www.afinitor.com/', conditions: ['Cancer support', 'Breast cancer', 'Kidney cancer'], conditionUrl: '/conditions/cancer-support', alternative: 'generic', manufacturer: 'Novartis Pharmaceuticals' },
  { id: 'med-0012', name: 'Aimovig® (erenumab-aooe)', url: 'https://www.aimovig.com/', conditions: ['Migraine', 'Neuroscience'], conditionUrl: '/conditions/migraine', alternative: 'none', manufacturer: 'Amgen Inc.' },
  { id: 'med-0013', name: 'Ajovy® (fremanezumab-vfrm)', url: 'https://www.ajovy.com/', conditions: ['Migraine', 'Neuroscience'], conditionUrl: '/conditions/migraine', alternative: 'none', manufacturer: 'Teva Pharmaceuticals' },
  { id: 'med-0014', name: 'Alecensa® (alectinib)', url: 'https://www.alecensa.com/', conditions: ['Cancer support', 'Lung cancer'], conditionUrl: '/conditions/cancer-support', alternative: 'none', manufacturer: 'Genentech USA, Inc.' },
  { id: 'med-0015', name: 'Ampyra® (dalfampridine)', url: null, conditions: ['Multiple sclerosis'], conditionUrl: '/conditions/multiple-sclerosis', alternative: 'generic', manufacturer: 'Acorda Therapeutics' },
  { id: 'med-0016', name: 'Avonex® (interferon beta-1a)', url: 'https://www.avonex.com/', conditions: ['Multiple sclerosis'], conditionUrl: '/conditions/multiple-sclerosis', alternative: 'none', manufacturer: 'Biogen' },
];

const ALTERNATIVE_LABELS = {
  any: '- Generic/Biosimilar -',
  generic: 'Generic(s) Available',
  biosimilar: 'Biosimilar(s) Available',
  none: 'None',
};

const SEARCH_HISTORY = [];
const MAX_HISTORY = 50;
const MAX_TERM_LENGTH = 120;

function tokenize(term) {
  return String(term || '')
    .toLowerCase()
    .replace(/[®™()[\],]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function normalizeQuery(body) {
  const term = typeof body.term === 'string' ? body.term.trim().slice(0, MAX_TERM_LENGTH) : '';
  const alternative = typeof body.alternative === 'string' && body.alternative in ALTERNATIVE_LABELS ? body.alternative : 'any';
  const page = Number.isInteger(body.page) && body.page > 0 ? body.page : 1;
  return {
    term,
    tokens: tokenize(term),
    page,
    facets: [{ key: 'alternative', value: alternative }],
  };
}

function buildFacetIndex(medications) {
  const index = {
    alternative: new Map(),
    condition: new Map(),
    manufacturer: new Map(),
  };
  for (const med of medications) {
    const alt = index.alternative.get(med.alternative) || new Set();
    alt.add(med.id);
    index.alternative.set(med.alternative, alt);
    for (const condition of med.conditions) {
      const key = condition.toLowerCase();
      const ids = index.condition.get(key) || new Set();
      ids.add(med.id);
      index.condition.set(key, ids);
    }
    const mk = med.manufacturer.toLowerCase();
    const mids = index.manufacturer.get(mk) || new Set();
    mids.add(med.id);
    index.manufacturer.set(mk, mids);
  }
  return index;
}

const FACET_INDEX = buildFacetIndex(MEDICATIONS);

function applyFacets(candidates, facets) {
  let ids = new Set(candidates.map((med) => med.id));
  for (const [key, value] of Object.entries(facets)) {
    if (value === 'any') continue;
    const bucket = FACET_INDEX[key].get(String(value).toLowerCase());
    ids = new Set([...ids].filter((id) => bucket && bucket.has(id)));
  }
  return candidates.filter((med) => ids.has(med.id));
}

function scoreMedication(med, tokens) {
  if (tokens.length === 0) return 1;
  const haystack = [med.name, med.manufacturer, ...med.conditions].join(' ').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (med.name.toLowerCase().startsWith(token)) score += 5;
    else if (haystack.includes(token)) score += 2;
  }
  return score;
}

function rankMatches(query) {
  const scored = MEDICATIONS
    .map((med) => ({ med, score: scoreMedication(med, query.tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.med.name.localeCompare(b.med.name))
    .map((entry) => entry.med);
  return applyFacets(scored, query.facets);
}

function paginate(matches, page) {
  const start = (page - 1) * PAGE_SIZE;
  return {
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(matches.length / PAGE_SIZE)),
    items: matches.slice(start, start + PAGE_SIZE),
  };
}

function formatRow(med) {
  return {
    id: med.id,
    name: med.name,
    url: med.url,
    conditions: med.conditions,
    conditionUrl: med.conditionUrl,
    alternative: med.alternative === 'none' ? '' : ALTERNATIVE_LABELS[med.alternative],
    manufacturer: med.manufacturer,
  };
}

function formatResults(requestId, query, matches) {
  const paged = paginate(matches, query.page);
  return {
    requestId,
    term: query.term,
    appliedFilters: query.facets
      .filter((facet) => facet.value !== 'any')
      .map((facet) => ({ facet: facet.key, label: ALTERNATIVE_LABELS[facet.value] || facet.value })),
    totalResults: matches.length,
    page: paged.page,
    totalPages: paged.totalPages,
    results: paged.items.map(formatRow),
  };
}

function recordHistory(entry) {
  SEARCH_HISTORY.unshift(entry);
  if (SEARCH_HISTORY.length > MAX_HISTORY) SEARCH_HISTORY.length = MAX_HISTORY;
}

function currentStatus() {
  const failed = SEARCH_HISTORY.filter((entry) => !entry.ok).length;
  return {
    state: failed > 0 ? 'degraded' : 'ready',
    searches: SEARCH_HISTORY.length,
    failed,
    lastSearchAt: SEARCH_HISTORY[0] ? SEARCH_HISTORY[0].at : null,
  };
}

function getCatalog() {
  return {
    total: TOTAL_LISTED,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(TOTAL_LISTED / PAGE_SIZE),
    alternatives: ALTERNATIVE_LABELS,
    medications: MEDICATIONS.slice(0, PAGE_SIZE).map(formatRow),
    status: currentStatus(),
  };
}

async function searchMedications(data) {
  const requestId = uuidv4();
  const started = Date.now();
  const query = normalizeQuery(data || {});

  logger.info('Medication search started', {
    requestId,
    term: query.term,
    tokens: query.tokens.length,
    page: query.page,
    facets: query.facets,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const matches = rankMatches(query);
    const response = formatResults(requestId, query, matches);

    const duration = Date.now() - started;
    recordTiming('medication_search.duration', duration, { route: ROUTE, status: 'success' });
    incrementMetric('medication_search.success', { route: ROUTE });
    recordHistory({ requestId, ok: true, term: query.term, results: response.totalResults, at: new Date().toISOString() });

    logger.info('Medication search completed', {
      requestId,
      results: response.totalResults,
      duration,
      service: SERVICE,
    });

    return response;
  } catch (error) {
    const duration = Date.now() - started;
    recordTiming('medication_search.duration', duration, { route: ROUTE, status: 'failure' });
    incrementMetric('medication_search.failure', { route: ROUTE, error_type: error.name });
    recordHistory({ requestId, ok: false, term: query.term, error: `${error.name}: ${error.message}`, at: new Date().toISOString() });

    logger.error('Medication search failed', {
      requestId,
      term: query.term,
      error: error.message,
      errorType: error.name,
      stack: error.stack,
      duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE },
      extra: { requestId, term: query.term, page: query.page },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f0fc78cc.js — searchMedications',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Specialty Pharmacy — Find a Medication search',
      slackMemberId: 'U0BDHHQUM24',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        requestId,
        term: query.term,
        page: query.page,
        facets: query.facets,
        catalogSize: MEDICATIONS.length,
        promptContext: 'The public medication finder returns a 500 for every search, including an empty search with the default filter. Patients and prescribers cannot look up whether a specialty medication is dispensed or which manufacturer supplies it until search is restored.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'f0fc78cc@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from medication search error', { error: err.message, service: SERVICE });
    });

    throw error;
  }
}

function resetSearch() {
  const cleared = SEARCH_HISTORY.length;
  SEARCH_HISTORY.length = 0;
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('medication_search.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, status: currentStatus() };
}

module.exports = { searchMedications, resetSearch, getCatalog, MEDICATIONS, ALTERNATIVE_LABELS };
