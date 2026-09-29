const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.HEBBIA_SLACK_MEMBER_ID || 'U0BQZBHCNMA';

const SERVICE = 'customer-7a925867-matrix-run';
const ROUTE = '/api/7a925867/matrix/columns/run';

const MATRIX = {
  id: 'mx_fintech_origination',
  name: 'Payments & FinTech Coverage \u2014 Origination Signal Matrix',
  project: 'Project Keystone',
  folder: 'FinTech Coverage',
};

const COLUMNS = [
  { key: 'company', label: 'Company', type: 'entity' },
  { key: 'sources', label: 'Source Documents', type: 'documents' },
  { key: 'subSector', label: 'Sub-sector', type: 'tag' },
  { key: 'portfolioActions', label: 'Portfolio Actions & Divestitures', type: 'text' },
  { key: 'scorecard', label: 'Origination Scorecard', type: 'tag' },
];

const doc = (id, title, type, filed, pages, ingest) => ({
  id, title, type, filed, ingest: ingest || 'native',
  ...(ingest === 'ocr' ? { ocr: { engine: 'ocr-v3', confidence: 0.93, pages } } : { layout: { pages } }),
});

/**
 * Coverage universe. Each company carries the filings Matrix has indexed for
 * it and the advisor mentions extracted from those filings at ingest time.
 */
const COMPANIES = [
  {
    id: 'co_ngp', name: 'Northgate Payments', ticker: 'NGP', logo: { bg: '#1D2B5B', glyph: 'N' },
    subSector: { label: 'Networks', tone: 'blue' },
    portfolioActions: 'Restructuring (Apr-2026) \u2014 $214 million charge tied to exit of prepaid card programs',
    scorecard: { label: 'Divestiture / Carve Out', tone: 'blue' },
    documents: [
      doc('d_ngp_10q', 'Northgate Payments - 10-Q (Aug 6, 2026)', '10-Q', '2026-08-06', { 41: { section: 'Note 14' } }),
      doc('d_ngp_8k', 'Northgate Payments - 8-K (Jul 22, 2026)', '8-K', '2026-07-22', { 2: { section: 'Item 1.01' } }),
      doc('d_ngp_def', 'Northgate Payments - DEF 14A (Apr 2026)', 'DEF 14A', '2026-04-18', { 63: { section: 'Fees Paid to Advisors' } }),
    ],
    advisors: [
      { bank: 'Goldman Sachs', role: 'Financial advisor on prepaid exit', docId: 'd_ngp_8k', page: 2, quote: 'Goldman Sachs & Co. LLC is serving as exclusive financial advisor to the Company in connection with the Transaction.' },
      { bank: 'Wachtell, Lipton', role: 'Legal counsel', docId: 'd_ngp_8k', page: 2, quote: 'Wachtell, Lipton, Rosen & Katz is serving as legal counsel to the Company.' },
    ],
  },
  {
    id: 'co_lmn', name: 'Lumen Ledger', ticker: 'LMN', logo: { bg: '#7C5CFF', glyph: 'L' },
    subSector: { label: 'Diversified', tone: 'red' },
    portfolioActions: 'Student loan servicing divestiture (Aug-2026) \u2014 definitive agreement signed with Arbor Capital',
    scorecard: { label: 'Divestiture / Carve Out', tone: 'blue' },
    documents: [
      doc('d_lmn_10q', 'Lumen Ledger - 10-Q (Aug 1, 2026)', '10-Q', '2026-08-01', { 18: { section: 'Note 3' } }),
      doc('d_lmn_8k', 'Lumen Ledger - 8-K (Aug 14, 2026)', '8-K', '2026-08-14', { 3: { section: 'Item 8.01' } }),
      doc('d_lmn_call', 'Lumen Ledger - Q2 2026 Earnings Call', 'Transcript', '2026-07-30', { 9: { section: 'Q&A' } }),
    ],
    advisors: [
      { bank: 'J.P. Morgan', role: 'Sell-side advisor, servicing divestiture', docId: 'd_lmn_8k', page: 3, quote: 'J.P. Morgan Securities LLC acted as financial advisor to Lumen Ledger on the sale of its student loan servicing business.' },
    ],
  },
  {
    id: 'co_arp', name: 'Arcadia Pay', ticker: 'ARP', logo: { bg: '#0F6B4F', glyph: 'A' },
    subSector: { label: 'Payment Processing', tone: 'blue' },
    portfolioActions: 'Minority stake sale in Nexa Payments (Jan-2026) \u2014 retained 19% interest',
    scorecard: { label: 'Divestiture / Carve Out', tone: 'blue' },
    documents: [
      doc('d_arp_10q', 'Arcadia Pay - 10-Q (Aug 4, 2026)', '10-Q', '2026-08-04', { 22: { section: 'Note 7' } }),
      doc('d_arp_10q2', 'Arcadia Pay - 10-Q (May 8, 2026)', '10-Q', '2026-05-08', { 20: { section: 'Note 7' } }),
      doc('d_arp_call', 'Arcadia Pay - Q2 2026 Earnings Call', 'Transcript', '2026-08-04', { 6: { section: 'Prepared remarks' } }),
    ],
    advisors: [
      { bank: 'Morgan Stanley', role: 'Advisor on Nexa stake sale', docId: 'd_arp_10q2', page: 20, quote: 'In connection with the sale, the Company engaged Morgan Stanley & Co. LLC as financial advisor.' },
    ],
  },
  {
    id: 'co_qry', name: 'Quarry Commerce', ticker: 'QRY', logo: { bg: '#E0672B', glyph: 'Q' },
    subSector: { label: 'Merchant Acquiring', tone: 'orange' },
    portfolioActions: 'Buyback and dividend action (Aug-2026) \u2014 Repurchased $350 million under ASR',
    scorecard: { label: 'Sell-Side / Take-Private', tone: 'blue' },
    documents: [
      doc('d_qry_8k', 'Quarry Commerce - 8-K (Aug 19, 2026)', '8-K', '2026-08-19', { 1: { section: 'Item 7.01' } }),
      doc('d_qry_10q', 'Quarry Commerce - Q2 2026 10-Q', '10-Q', '2026-08-07', { 33: { section: 'Note 12' } }),
      doc('d_qry_call', 'Quarry Commerce - Q2 2026 Earnings Call', 'Transcript', '2026-08-07', { 11: { section: 'Q&A' } }),
    ],
    advisors: [
      { bank: 'Centerview Partners', role: 'Advising special committee (strategic review)', docId: 'd_qry_8k', page: 1, quote: 'The special committee has retained Centerview Partners LLC as its independent financial advisor.' },
      { bank: 'BofA Securities', role: 'ASR counterparty', docId: 'd_qry_10q', page: 33, quote: 'The Company entered into an accelerated share repurchase agreement with Bank of America, N.A.' },
    ],
  },
  {
    id: 'co_smr', name: 'Summit Rails', ticker: 'SMR', logo: { bg: '#2F6FEB', glyph: 'S' },
    subSector: { label: 'Digital Wallets & P2P', tone: 'purple' },
    portfolioActions: 'Strategic reorganization and business simplification (Jul-2026) \u2014 exiting crypto custody',
    scorecard: { label: 'Sell-Side / Take-Private', tone: 'blue' },
    documents: [
      doc('d_smr_8k', 'Summit Rails - 8-K (Financial results, Jul 2026)', '8-K', '2026-07-29', { 4: { section: 'Ex. 99.1' } }),
      doc('d_smr_10q', 'Summit Rails - 10-Q (Jul 29, 2026)', '10-Q', '2026-07-29', { 27: { section: 'Note 9' } }),
      doc('d_smr_10q2', 'Summit Rails - 10-Q (May 2026)', '10-Q', '2026-05-06', { 25: { section: 'Note 9' } }),
    ],
    advisors: [
      { bank: 'Qatalyst Partners', role: 'Advisor on custody exit', docId: 'd_smr_10q', page: 27, quote: 'The Company has engaged Qatalyst Partners LP to advise on strategic alternatives for its custody business.' },
    ],
  },
  {
    id: 'co_cvc', name: 'Corvid Clearing', ticker: 'CVC', logo: { bg: '#111111', glyph: 'C' },
    subSector: { label: 'Diversified', tone: 'red' },
    portfolioActions: 'Minority stake sale (Jun-2026) \u2014 Non-marketable securities portfolio to Halden Partners',
    scorecard: { label: 'Divestiture / Carve Out', tone: 'blue' },
    documents: [
      doc('d_cvc_10q', 'Corvid Clearing - 10-Q (Aug 2026)', '10-Q', '2026-08-05', { 19: { section: 'Note 5' } }),
      doc('d_cvc_10k', 'Corvid Clearing - 10-K (FY2025)', '10-K', '2026-02-26', { 88: { section: 'Item 7' } }),
      doc('d_cvc_ex991', 'Corvid Clearing - 8-K Ex. 99.1 Press Release (scanned)', '8-K', '2026-09-02', { 2: { section: 'Advisors' } }, 'ocr'),
    ],
    advisors: [
      { bank: 'Evercore', role: 'Financial advisor, clearing unit review', docId: 'd_cvc_ex991', page: 2, quote: 'Evercore is acting as financial advisor and Sullivan & Cromwell LLP as legal counsel to Corvid Clearing.' },
      { bank: 'Sullivan & Cromwell', role: 'Legal counsel', docId: 'd_cvc_ex991', page: 2, quote: 'Evercore is acting as financial advisor and Sullivan & Cromwell LLP as legal counsel to Corvid Clearing.' },
    ],
  },
  {
    id: 'co_ibf', name: 'Ironbridge Fintech', ticker: 'IBF', logo: { bg: '#3B3F46', glyph: 'I' },
    subSector: { label: 'Diversified', tone: 'red' },
    portfolioActions: 'Vehicle maintenance business sale (Aug-2026) \u2014 $610 million to fleet services buyer',
    scorecard: { label: 'Divestiture / Carve Out', tone: 'blue' },
    documents: [
      doc('d_ibf_8k', 'Ironbridge Fintech - 8-K (Aug 12, 2026)', '8-K', '2026-08-12', { 2: { section: 'Item 1.01' } }),
      doc('d_ibf_call', 'Ironbridge Fintech - Q2 2026 Earnings Call', 'Transcript', '2026-08-06', { 5: { section: 'Prepared remarks' } }),
      doc('d_ibf_inv', 'Ironbridge Fintech - Q2 2026 Investor Presentation', 'Presentation', '2026-08-06', { 14: { section: 'Portfolio' } }),
    ],
    advisors: [
      { bank: 'Lazard', role: 'Sell-side advisor, fleet maintenance sale', docId: 'd_ibf_8k', page: 2, quote: 'Lazard served as financial advisor to Ironbridge in connection with the sale.' },
    ],
  },
  {
    id: 'co_prx', name: 'Parallax Processing', ticker: 'PRX', logo: { bg: '#D6453D', glyph: 'P' },
    subSector: { label: 'Merchant Acquiring', tone: 'orange' },
    portfolioActions: 'Share repurchase authorization (May-2026) \u2014 Board added $1.0 billion',
    scorecard: { label: 'Activist Defence', tone: 'red' },
    documents: [
      doc('d_prx_def', 'Parallax Processing - DEFA14A (Jun 2026)', 'DEFA14A', '2026-06-03', { 7: { section: 'Letter to Shareholders' } }),
      doc('d_prx_10q', 'Parallax Processing - 10-Q (Aug 2026)', '10-Q', '2026-08-08', { 30: { section: 'Note 11' } }),
      doc('d_prx_13d', 'Parallax Processing - SC 13D (Crestline Capital)', 'SC 13D', '2026-05-21', { 4: { section: 'Item 4' } }),
    ],
    advisors: [
      { bank: 'Goldman Sachs', role: 'Defense advisor vs. Crestline', docId: 'd_prx_def', page: 7, quote: 'The Board, together with its advisors Goldman Sachs and Skadden, has engaged extensively with Crestline.' },
      { bank: 'Skadden', role: 'Legal counsel (proxy contest)', docId: 'd_prx_def', page: 7, quote: 'The Board, together with its advisors Goldman Sachs and Skadden, has engaged extensively with Crestline.' },
    ],
  },
  {
    id: 'co_tsl', name: 'Tessellate', ticker: 'TSL', logo: { bg: '#5A4FCF', glyph: 'T' },
    subSector: { label: 'Networks', tone: 'blue' },
    portfolioActions: 'Share repurchases (Jun-2026) \u2014 Repurchased 4.1 million shares in Q2',
    scorecard: { label: 'ECM / DCM', tone: 'gray' },
    documents: [
      doc('d_tsl_10q', 'Tessellate - 10-Q (Jul 2026)', '10-Q', '2026-07-31', { 24: { section: 'Part II, Item 2' } }),
      doc('d_tsl_8k', 'Tessellate - 8-K (Notes offering)', '8-K', '2026-06-10', { 1: { section: 'Item 8.01' } }),
      doc('d_tsl_call', 'Tessellate - Q2 2026 Earnings Call', 'Transcript', '2026-07-31', { 8: { section: 'Q&A' } }),
    ],
    advisors: [
      { bank: 'Citigroup', role: 'Lead bookrunner, senior notes', docId: 'd_tsl_8k', page: 1, quote: 'Citigroup Global Markets Inc. acted as lead book-running manager for the offering.' },
    ],
  },
  {
    id: 'co_hlr', name: 'Halcyon Remit', ticker: 'HLR', logo: { bg: '#1B8FB5', glyph: 'H' },
    subSector: { label: 'Digital Wallets & P2P', tone: 'purple' },
    portfolioActions: 'BorderLink regulatory approval suspension (Jul-2026) \u2014 $500M acquisition delayed',
    scorecard: { label: 'Buy-Side / Consolidator', tone: 'red' },
    documents: [
      doc('d_hlr_8k', 'Halcyon Remit - 8-K (Jul 18, 2026)', '8-K', '2026-07-18', { 2: { section: 'Item 8.01' } }),
      doc('d_hlr_10q', 'Halcyon Remit - 10-Q (Aug 2026)', '10-Q', '2026-08-06', { 15: { section: 'Note 2' } }),
      doc('d_hlr_s4', 'Halcyon Remit - S-4 (BorderLink)', 'S-4', '2026-03-12', { 61: { section: 'Opinion of Financial Advisor' } }),
    ],
    advisors: [
      { bank: 'PJT Partners', role: 'Buy-side advisor, BorderLink', docId: 'd_hlr_s4', page: 61, quote: 'PJT Partners LP rendered its opinion to the Halcyon board that the consideration was fair, from a financial point of view.' },
    ],
  },
  {
    id: 'co_bwc', name: 'Brightwater Card', ticker: 'BWC', logo: { bg: '#0E7C66', glyph: 'B' },
    subSector: { label: 'Payment Processing', tone: 'blue' },
    portfolioActions: 'Convertible-note repurchase authorization (Dec-2025) \u2014 up to $400 million',
    scorecard: { label: 'Special Committee', tone: 'purple' },
    documents: [
      doc('d_bwc_8k', 'Brightwater Card - 8-K (Sep 8, 2026)', '8-K', '2026-09-08', { 1: { section: 'Item 8.01' } }),
      doc('d_bwc_10q', 'Brightwater Card - 10-Q (Aug 2026)', '10-Q', '2026-08-03', { 29: { section: 'Note 10' } }),
      doc('d_bwc_call', 'Brightwater Card - Q2 2026 Earnings Call', 'Transcript', '2026-08-03', { 12: { section: 'Q&A' } }),
    ],
    advisors: [
      { bank: 'Moelis & Company', role: 'Advising special committee', docId: 'd_bwc_8k', page: 1, quote: 'The special committee has retained Moelis & Company LLC as financial advisor.' },
    ],
  },
  {
    id: 'co_wrn', name: 'Wren Payments', ticker: 'WRN', logo: { bg: '#B7791F', glyph: 'W' },
    subSector: { label: 'Networks', tone: 'blue' },
    portfolioActions: 'Marketing spend reduction (Jun-2026) \u2014 Q2 sales & marketing down 18% y/y',
    scorecard: { label: 'Special Committee', tone: 'purple' },
    documents: [
      doc('d_wrn_10q', 'Wren Payments - 10-Q (Aug 2026)', '10-Q', '2026-08-09', { 21: { section: 'MD&A' } }),
      doc('d_wrn_call', 'Wren Payments - Q2 2026 Earnings Call', 'Transcript', '2026-08-09', { 7: { section: 'Q&A' } }),
      doc('d_wrn_def', 'Wren Payments - DEF 14A (May 2026)', 'DEF 14A', '2026-05-01', { 44: { section: 'Compensation Consultant' } }),
    ],
    advisors: [],
  },
];

const ADVISOR_PROMPT = 'Which banks and law firms are currently advising the company, and on what? Cite the filing.';

function getMatrix() {
  return {
    ...MATRIX,
    columns: COLUMNS,
    suggestedColumn: { label: 'Advisors on record', prompt: ADVISOR_PROMPT, type: 'list' },
    rows: COMPANIES.map((c) => ({
      id: c.id,
      name: c.name,
      ticker: c.ticker,
      logo: c.logo,
      subSector: c.subSector,
      portfolioActions: c.portfolioActions,
      scorecard: c.scorecard,
      documents: c.documents.map((d) => ({ id: d.id, title: d.title, type: d.type, filed: d.filed, ingest: d.ingest })),
    })),
  };
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function resolveColumnSpec(column) {
  const label = String(column.label || '').trim();
  const prompt = String(column.prompt || '').trim();
  if (!label || !prompt) {
    throw validationError('Give the column a name and a question to answer.', 'COLUMN_SPEC_INVALID');
  }
  if (!/advis|bank|counsel/i.test(`${label} ${prompt}`)) {
    throw validationError('This coverage set is indexed for advisor mentions only.', 'COLUMN_SPEC_UNSUPPORTED');
  }
  return { key: 'advisors', label, prompt, type: 'list' };
}

/**
 * Shape an indexed filing into the reader's working view, with the page index
 * used to anchor citations back to the source PDF.
 */
function normalizeDocument(d) {
  return {
    id: d.id,
    title: d.title,
    type: d.type,
    ingest: d.ingest,
    pages: d.layout && d.layout.pages,
  };
}

function readCompany(company) {
  const docs = Object.fromEntries(company.documents.map((d) => [d.id, normalizeDocument(d)]));
  return { company, docs, hits: company.advisors };
}

/**
 * Anchor each advisor mention to the page region it came from so the cell can
 * link straight to the highlighted passage.
 */
function attachCitations(read) {
  const items = read.hits.map((hit, i) => {
    const source = read.docs[hit.docId];
    const region = source.pages[hit.page];
    return {
      label: hit.bank,
      detail: hit.role,
      citation: {
        index: i + 1,
        docId: source.id,
        docTitle: source.title,
        page: hit.page,
        section: region.section,
        quote: hit.quote,
      },
    };
  });
  return {
    rowId: read.company.id,
    items,
    empty: items.length === 0 ? 'No advisor disclosed in indexed filings' : null,
  };
}

async function runColumn(data) {
  const startTime = Date.now();
  const runId = `run_${uuidv4().slice(0, 8)}`;
  const column = data.column || {};

  logger.info('Running Matrix column', {
    runId, matrixId: MATRIX.id, column: column.label, service: SERVICE, route: ROUTE,
  });

  try {
    const spec = resolveColumnSpec(column);
    const rows = Array.isArray(data.rowIds) && data.rowIds.length
      ? COMPANIES.filter((c) => data.rowIds.includes(c.id))
      : COMPANIES;

    await new Promise((resolve) => setTimeout(resolve, 2200 + Math.random() * 800));

    const cells = rows.map(readCompany).map(attachCitations);

    const duration = Date.now() - startTime;
    incrementMetric('matrix_column.success', { route: ROUTE, column: spec.key });
    recordTiming('matrix_column.latency', duration, { route: ROUTE });

    return {
      success: true,
      runId,
      column: spec,
      cells,
      summary: {
        rows: cells.length,
        citations: cells.reduce((n, c) => n + c.items.length, 0),
      },
    };
  } catch (error) {
    if (error.name === 'ValidationError') throw error;

    const duration = Date.now() - startTime;
    incrementMetric('matrix_column.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('matrix_column.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Matrix column run failed', {
      runId, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, column: column.label },
      extra: { runId, matrixId: MATRIX.id },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/7a925867.js \u2014 attachCitations',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Hebbia Matrix \u2014 Add column',
      customer: '7a925867',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'column', value: column.label || '' },
      ],
      extra: { runId, matrixId: MATRIX.id, rows: COMPANIES.length },
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
    }).catch((err) => {
      logger.error('Failed to create Devin session for Matrix column error', { error: err.message, runId });
    });

    error.requestId = runId;
    throw error;
  }
}

module.exports = {
  runColumn,
  getMatrix,
  COMPANIES,
};
