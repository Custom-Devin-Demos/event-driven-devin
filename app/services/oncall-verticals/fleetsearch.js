const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const CONTENT = require('./fleetsearch-content.json');

const ROUTE = '/api/oncall/fleetsearch/search';
const SITE = 'https://services.boeing.com';
const SHOP = 'https://shop.boeing.com/aviation-supply';
const MAX_QUERY = 100;
const MAX_RESULTS = 20;
const PART_NUMBER = /^(?=.*\d)[A-Z0-9]{2,}(?:-[A-Z0-9]+)+$|^BAC[A-Z]\d{2}[A-Z0-9-]+$/;

/**
 * Parts Interchangeability (PIR) record types, keyed by the code carried on
 * each record in the nightly PIR feed.
 */
const INTERCHANGE_CODES = {
  TWO_WAY: { label: 'Two-way interchangeable', rank: 1 },
  ONE_WAY: { label: 'One-way interchangeable (replacement only)', rank: 2 },
  INTERMIXABLE: { label: 'Intermixable within the same assembly', rank: 3 },
  NOT_INTERCHANGEABLE: { label: 'Not interchangeable', rank: 9 },
};

/**
 * Parts index with interchangeability records from the PIR feed
 * (pir-feed@2026.11.05 import).
 */
const PARTS = {
  'BACB30LH3-4': {
    nomenclature: 'Bolt, Hex Head, Close Tolerance',
    models: ['737', '747', '757', '767', '777', '787'],
    ata: '51-40',
    interchange: [{ partNumber: 'BACB30LH3-4A', code: 'TWO_WAY' }],
  },
  'BACR15GF6D6': {
    nomenclature: 'Rivet, Universal Head, Solid',
    models: ['737', '757', '767', '777'],
    ata: '51-40',
    interchange: [{ partNumber: 'BACR15GF6D6C', code: 'INTERMIXABLE' }],
  },
  '65C27561-6': {
    nomenclature: 'Valve Assembly, Check — Hydraulic Return',
    models: ['737-800', '737-900ER'],
    ata: '29-11',
    interchange: [
      { partNumber: '65C27561-5', code: 'ONE_WAY', note: 'Dash 5 may be replaced by dash 6; dash 6 must not be replaced by dash 5.' },
    ],
  },
  '161A1100-77': {
    nomenclature: 'Beam Assembly, Main Landing Gear',
    models: ['737-800', '737 MAX 8'],
    ata: '32-11',
    interchange: [
      { partNumber: '161A1100-75', code: 'ONE_WAY' },
      { partNumber: '161A1100-73', code: 'NOT_INTERCHANGEABLE' },
    ],
  },
  '233A3203-2': {
    nomenclature: 'Filter Element, Air Conditioning Recirculation',
    models: ['777-200ER', '777-300ER'],
    ata: '21-25',
    interchange: [{ partNumber: '233A3203-1', code: 'TWO_WAY' }],
  },
  '414T4110-12': {
    nomenclature: 'Valve Assembly, Pack Flow Control',
    models: ['737 MAX 8', '737 MAX 9'],
    ata: '21-51',
    interchange: [
      { partNumber: '414T4110-11', code: 'TWO_WAY' },
      { partNumber: '414T4110-10', code: 'ONE_WAY_POST_SB', serviceBulletin: '737-21-1203' },
    ],
  },
  'S283W601-310': {
    nomenclature: 'Seal, Cargo Door Lower Sill',
    models: ['767-300F'],
    ata: '52-34',
    interchange: [],
  },
};

function searchError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function normalizeQuery(raw) {
  const query = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!query) throw searchError('Enter a keyword, term or part number.', 'INVALID_QUERY', 400);
  if (query.length > MAX_QUERY) throw searchError('Search terms must be 100 characters or fewer.', 'INVALID_QUERY', 400);
  return query;
}

function isPartNumber(query) {
  return PART_NUMBER.test(query.toUpperCase());
}

function contentResults(query) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!terms.length) return { total: 0, results: [] };
  const scored = [];
  for (const doc of CONTENT) {
    const title = doc.title.toLowerCase();
    const text = `${title} ${doc.description.toLowerCase()} ${doc.path.replace(/[/-]/g, ' ')}`;
    if (!terms.every((t) => text.includes(t))) continue;
    const score = terms.reduce((s, t) => s + (title.includes(t) ? 3 : 1), 0) + (doc.path.startsWith('news/') ? 0 : 1);
    scored.push({ score, doc });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    total: scored.length,
    results: scored.slice(0, MAX_RESULTS).map(({ doc }) => ({
      type: 'content',
      title: doc.title,
      url: `${SITE}/${doc.path}`,
      description: doc.description,
    })),
  };
}

function interchangeability(partNumber, part) {
  return part.interchange
    .map((record) => {
      const type = INTERCHANGE_CODES[record.code];
      return {
        partNumber: record.partNumber,
        code: record.code,
        label: type.label,
        rank: type.rank,
        note: record.note || null,
      };
    })
    .sort((a, b) => a.rank - b.rank);
}

function partResult(partNumber) {
  const part = PARTS[partNumber];
  if (!part) return null;
  const records = interchangeability(partNumber, part);
  const alternates = records.length
    ? records.map((r) => `${r.partNumber} (${r.label.toLowerCase()})`).join('; ')
    : 'no interchangeable alternates on record';
  return {
    type: 'part',
    partNumber,
    title: `${partNumber} — ${part.nomenclature}`,
    url: `${SHOP}/search?text=${encodeURIComponent(partNumber)}`,
    description: `Boeing part ${partNumber}, ATA ${part.ata}, effective on ${part.models.join(', ')}. Interchangeability: ${alternates}.`,
    interchangeability: records,
  };
}

async function searchFleet(body = {}) {
  const started = Date.now();
  const query = normalizeQuery(body.query);
  const tags = [`route:${ROUTE}`];
  try {
    const results = [];
    let total = 0;
    let queryType = 'keyword';
    if (isPartNumber(query)) {
      queryType = 'part';
      const part = partResult(query.toUpperCase());
      if (part) {
        results.push(part);
        total += 1;
      }
    }
    const content = contentResults(query);
    total += content.total;
    results.push(...content.results.slice(0, MAX_RESULTS - results.length));
    incrementMetric('fleetsearch.search.success', [...tags, `query_type:${queryType}`]);
    return { success: true, query, queryType, total, results };
  } catch (error) {
    incrementMetric('fleetsearch.search.error', tags);
    logger.error('MyBoeingFleet search failed', { route: ROUTE, query, error: error.message });
    Sentry.captureException(error, { tags: { vertical: 'fleetsearch', route: ROUTE }, extra: { query } });
    throw error;
  } finally {
    recordTiming('fleetsearch.search.duration', Date.now() - started, tags);
  }
}

module.exports = { searchFleet, isPartNumber, INTERCHANGE_CODES, PARTS };
