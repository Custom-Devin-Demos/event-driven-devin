const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.HEBBIA_SLACK_MEMBER_ID || 'U0BQZBHCNMA';

const SERVICE = 'customer-7a925867-matrix-run';
const ROUTE = '/api/7a925867/matrix/columns/run';

const MATRIX = {
  id: 'mx_acme_contract_review',
  name: 'ACME — Contract Review Summary',
  project: 'Project Alpha',
  dataRoom: 'ACME Industrial Holdings · Sell-side VDR',
};

/**
 * Existing Matrix columns, already populated from the ingest-time metadata.
 */
const BASE_COLUMNS = [
  { key: 'counterparty', label: 'Counterparty', format: 'text' },
  { key: 'agreementType', label: 'Agreement type', format: 'text' },
  { key: 'term', label: 'Term / expiry', format: 'date' },
  { key: 'governingLaw', label: 'Governing law', format: 'text' },
];

/**
 * Column templates offered in the Add column panel. `clauseKey` maps the
 * question onto the clause index built during ingest.
 */
const COLUMN_TEMPLATES = {
  change_of_control: {
    label: 'Change of control provisions',
    prompt: 'Does a change of control of ACME require counterparty consent, give notice, or trigger a termination right? Quote the operative language.',
    clauseKey: 'changeOfControl',
    format: 'classification',
  },
  assignment: {
    label: 'Assignment restrictions',
    prompt: 'Can ACME assign this agreement without consent, including by operation of law or merger?',
    clauseKey: 'assignment',
    format: 'classification',
  },
  termination: {
    label: 'Termination for convenience',
    prompt: 'Does either party have a right to terminate for convenience? State the notice period.',
    clauseKey: 'termination',
    format: 'text',
  },
};

const FLAG_LABELS = {
  consent: 'Consent required',
  termination: 'Termination right',
  notice: 'Notice only',
  none: 'No restriction',
};

/**
 * Data room documents as produced by the ingest pipeline. Native PDFs carry a
 * `layout` block from the PDF parser; scanned exhibits go through OCR and carry
 * an `ocr` block with the same page index shape.
 */
const DOCUMENTS = [
  {
    id: 'doc_01',
    name: 'Northwind Logistics — Master Services Agreement.pdf',
    source: 'native',
    pageCount: 42,
    meta: { counterparty: 'Northwind Logistics, Inc.', agreementType: 'Master Services Agreement', term: 'Mar 31, 2028', governingLaw: 'New York' },
    layout: { pages: { 18: { bbox: [72, 412, 468, 96], section: '14.3' }, 19: { bbox: [72, 120, 468, 64], section: '14.4' }, 31: { bbox: [72, 300, 468, 80], section: '21.2' } } },
    clauses: {
      changeOfControl: { flag: 'consent', page: 18, summary: 'Consent required; Northwind may terminate on 60 days\u2019 notice if consent is withheld.', quote: 'Any Change of Control of Customer shall require the prior written consent of Provider, not to be unreasonably withheld.' },
      assignment: { flag: 'consent', page: 19, summary: 'No assignment without consent, including by merger or operation of law.', quote: 'Neither party may assign this Agreement, whether by merger, operation of law or otherwise, without prior written consent.' },
      termination: { flag: 'none', page: 31, summary: 'Customer may terminate for convenience on 180 days\u2019 notice after year two.', quote: 'Following the second anniversary, Customer may terminate for convenience upon one hundred eighty (180) days\u2019 notice.' },
    },
  },
  {
    id: 'doc_02',
    name: 'Halvorsen Components GmbH — Supply Agreement.pdf',
    source: 'native',
    pageCount: 36,
    meta: { counterparty: 'Halvorsen Components GmbH', agreementType: 'Supply Agreement', term: 'Dec 31, 2027', governingLaw: 'Germany' },
    layout: { pages: { 22: { bbox: [64, 240, 480, 88], section: '17.1' }, 23: { bbox: [64, 96, 480, 72], section: '17.2' }, 27: { bbox: [64, 510, 480, 60], section: '19.4' } } },
    clauses: {
      changeOfControl: { flag: 'termination', page: 22, summary: 'Supplier may terminate within 90 days of a change of control.', quote: 'Supplier may terminate this Agreement by written notice within ninety (90) days after becoming aware of a Change of Control of Buyer.' },
      assignment: { flag: 'consent', page: 23, summary: 'Assignment to affiliates permitted; otherwise consent required.', quote: 'Buyer may assign to an Affiliate upon notice; any other assignment requires Supplier\u2019s prior written consent.' },
      termination: { flag: 'none', page: 27, summary: 'No termination for convenience.', quote: 'This Agreement may be terminated only in accordance with Sections 19.1 through 19.3.' },
    },
  },
  {
    id: 'doc_03',
    name: 'Veridian Systems — Enterprise Software License.pdf',
    source: 'native',
    pageCount: 28,
    meta: { counterparty: 'Veridian Systems Corp.', agreementType: 'Software License Agreement', term: 'Jun 30, 2026 (auto-renew)', governingLaw: 'Delaware' },
    layout: { pages: { 14: { bbox: [72, 188, 468, 110], section: '12.5' }, 15: { bbox: [72, 72, 468, 70], section: '12.6' }, 20: { bbox: [72, 330, 468, 58], section: '15.2' } } },
    clauses: {
      changeOfControl: { flag: 'notice', page: 14, summary: 'Notice within 30 days; license transfers to successor.', quote: 'Licensee shall notify Licensor in writing within thirty (30) days following any Change of Control; the license shall continue for the benefit of the successor.' },
      assignment: { flag: 'none', page: 15, summary: 'Freely assignable to a successor in a sale of the business.', quote: 'Licensee may assign this Agreement to a successor to all or substantially all of its business without consent.' },
      termination: { flag: 'none', page: 20, summary: 'Licensee may terminate for convenience on 90 days\u2019 notice.', quote: 'Licensee may terminate this Agreement for convenience on ninety (90) days\u2019 prior written notice.' },
    },
  },
  {
    id: 'doc_04',
    name: 'Castellan Retail Group — Distribution Agreement.pdf',
    source: 'native',
    pageCount: 51,
    meta: { counterparty: 'Castellan Retail Group plc', agreementType: 'Distribution Agreement', term: 'Sep 30, 2029', governingLaw: 'England & Wales' },
    layout: { pages: { 33: { bbox: [70, 260, 472, 120], section: '24.1' }, 34: { bbox: [70, 90, 472, 64], section: '24.3' }, 40: { bbox: [70, 420, 472, 70], section: '28.2' } } },
    clauses: {
      changeOfControl: { flag: 'consent', page: 33, summary: 'Consent required; exclusivity lapses on a change of control to a competitor.', quote: 'A Change of Control of the Company in favour of a Competitor shall require Distributor\u2019s consent, failing which the exclusivity granted in Clause 3 shall lapse.' },
      assignment: { flag: 'consent', page: 34, summary: 'No assignment without consent.', quote: 'Neither party shall assign, novate or otherwise transfer its rights without the prior written consent of the other.' },
      termination: { flag: 'none', page: 40, summary: 'Either party may terminate on 12 months\u2019 notice.', quote: 'Either party may terminate this Agreement on not less than twelve (12) months\u2019 written notice.' },
    },
  },
  {
    id: 'doc_05',
    name: 'Exhibit 10.4 — 1200 Industrial Pkwy Lease (scanned).pdf',
    source: 'scanned',
    pageCount: 64,
    meta: { counterparty: 'Parkway Industrial REIT, LLC', agreementType: 'Commercial Lease', term: 'Jan 31, 2034', governingLaw: 'Ohio' },
    ocr: { engine: 'ocr-v3', confidence: 0.94, pages: { 12: { bbox: [58, 344, 492, 102], section: '9(b)' }, 13: { bbox: [58, 120, 492, 88], section: '9(c)' }, 47: { bbox: [58, 210, 492, 60], section: '26' } } },
    clauses: {
      changeOfControl: { flag: 'consent', page: 12, summary: 'Transfer of >50% of equity deemed an assignment requiring landlord consent.', quote: 'Any transfer of more than fifty percent (50%) of the equity interests in Tenant shall be deemed an assignment requiring Landlord\u2019s prior written consent.' },
      assignment: { flag: 'consent', page: 13, summary: 'Landlord consent required; recapture right on proposed assignment.', quote: 'Landlord shall have the right to recapture the Premises upon receipt of any request for consent to assign.' },
      termination: { flag: 'none', page: 47, summary: 'No termination for convenience.', quote: 'Tenant shall have no right to terminate this Lease prior to the Expiration Date except as expressly set forth herein.' },
    },
  },
  {
    id: 'doc_06',
    name: 'Brightline Energy — Customer Agreement.pdf',
    source: 'native',
    pageCount: 22,
    meta: { counterparty: 'Brightline Energy Partners', agreementType: 'Customer Agreement', term: 'Feb 28, 2027', governingLaw: 'Texas' },
    layout: { pages: { 11: { bbox: [72, 280, 468, 84], section: '10.2' }, 12: { bbox: [72, 90, 468, 60], section: '10.3' }, 16: { bbox: [72, 400, 468, 52], section: '13.1' } } },
    clauses: {
      changeOfControl: { flag: 'none', page: 11, summary: 'No change of control provision.', quote: 'Nothing in this Agreement shall restrict any change in the ownership or control of either party.' },
      assignment: { flag: 'notice', page: 12, summary: 'Assignable on written notice.', quote: 'Either party may assign this Agreement upon written notice to the other party.' },
      termination: { flag: 'none', page: 16, summary: 'Customer may terminate for convenience on 30 days\u2019 notice.', quote: 'Customer may terminate for convenience upon thirty (30) days\u2019 written notice.' },
    },
  },
  {
    id: 'doc_07',
    name: 'First Harbor Bank — Credit Agreement.pdf',
    source: 'native',
    pageCount: 118,
    meta: { counterparty: 'First Harbor Bank, N.A. (Agent)', agreementType: 'Credit Agreement', term: 'Aug 15, 2028', governingLaw: 'New York' },
    layout: { pages: { 87: { bbox: [72, 150, 468, 132], section: '8.1(k)' }, 104: { bbox: [72, 360, 468, 70], section: '10.6' }, 92: { bbox: [72, 240, 468, 60], section: '2.5' } } },
    clauses: {
      changeOfControl: { flag: 'termination', page: 87, summary: 'Change of control is an Event of Default; commitments may be terminated.', quote: 'The occurrence of any Change of Control shall constitute an Event of Default hereunder.' },
      assignment: { flag: 'consent', page: 104, summary: 'Borrower may not assign without consent of each Lender.', quote: 'The Borrower may not assign or otherwise transfer any of its rights hereunder without the prior written consent of each Lender.' },
      termination: { flag: 'none', page: 92, summary: 'Borrower may reduce or terminate commitments on 3 business days\u2019 notice.', quote: 'The Borrower may terminate the Commitments upon three (3) Business Days\u2019 notice.' },
    },
  },
  {
    id: 'doc_08',
    name: 'Kestrel Robotics — Joint Development Agreement.pdf',
    source: 'native',
    pageCount: 34,
    meta: { counterparty: 'Kestrel Robotics, Inc.', agreementType: 'Joint Development Agreement', term: 'Nov 30, 2027', governingLaw: 'California' },
    layout: { pages: { 26: { bbox: [72, 200, 468, 110], section: '16.2' }, 27: { bbox: [72, 80, 468, 60], section: '16.4' }, 29: { bbox: [72, 330, 468, 60], section: '17.1' } } },
    clauses: {
      changeOfControl: { flag: 'termination', page: 26, summary: 'Kestrel may terminate and take an exclusive license to joint IP.', quote: 'Upon a Change of Control of ACME, Kestrel may terminate this Agreement and shall receive an exclusive license to the Joint IP.' },
      assignment: { flag: 'consent', page: 27, summary: 'Consent required.', quote: 'This Agreement may not be assigned by either party without the prior written consent of the other party.' },
      termination: { flag: 'none', page: 29, summary: 'Either party may terminate on 6 months\u2019 notice.', quote: 'Either party may terminate this Agreement for convenience upon six (6) months\u2019 written notice.' },
    },
  },
];

function getMatrix() {
  return {
    ...MATRIX,
    columns: BASE_COLUMNS,
    templates: Object.entries(COLUMN_TEMPLATES).map(([key, t]) => ({
      key, label: t.label, prompt: t.prompt, format: t.format,
    })),
    rows: DOCUMENTS.map((doc) => ({
      id: doc.id,
      name: doc.name,
      source: doc.source,
      pageCount: doc.pageCount,
      cells: doc.meta,
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
  const template = COLUMN_TEMPLATES[column.templateKey];
  if (!template) {
    throw validationError('Pick a column template or enter a question.', 'COLUMN_SPEC_INVALID');
  }
  return {
    key: column.templateKey,
    label: (column.label || template.label).trim(),
    prompt: (column.prompt || template.prompt).trim(),
    clauseKey: template.clauseKey,
    format: template.format,
  };
}

/**
 * Shape an ingested document into the reader's working view: clause index plus
 * the page index used to anchor citations back to the source PDF.
 */
function normalizeDocument(doc) {
  return {
    id: doc.id,
    name: doc.name,
    source: doc.source,
    pageCount: doc.pageCount,
    clauses: doc.clauses,
    pages: doc.layout && doc.layout.pages,
  };
}

function readCell(doc, spec) {
  const clause = doc.clauses[spec.clauseKey];
  if (!clause) {
    return { docId: doc.id, flag: 'none', value: 'Not addressed in document.', hits: [] };
  }
  return {
    docId: doc.id,
    flag: clause.flag,
    value: clause.summary,
    hits: [{ page: clause.page, quote: clause.quote }],
  };
}

/**
 * Anchor each hit to its page region so the viewer can jump to and highlight
 * the exact passage.
 */
function attachCitations(cell, doc) {
  const citations = cell.hits.map((hit, i) => {
    const region = doc.pages[hit.page];
    return {
      index: i + 1,
      page: hit.page,
      section: region.section,
      bbox: region.bbox,
      quote: hit.quote,
    };
  });
  return {
    docId: cell.docId,
    flag: cell.flag,
    flagLabel: FLAG_LABELS[cell.flag],
    value: cell.value,
    citations,
  };
}

async function runColumn(data) {
  const startTime = Date.now();
  const runId = `run_${uuidv4().slice(0, 8)}`;
  const column = data.column || {};

  logger.info('Running Matrix column', {
    runId, matrixId: MATRIX.id, templateKey: column.templateKey, service: SERVICE, route: ROUTE,
  });

  try {
    const spec = resolveColumnSpec(column);
    const requested = Array.isArray(data.documentIds) && data.documentIds.length
      ? DOCUMENTS.filter((d) => data.documentIds.includes(d.id))
      : DOCUMENTS;

    await new Promise((resolve) => setTimeout(resolve, 900 + Math.random() * 600));

    const cells = requested
      .map(normalizeDocument)
      .map((doc) => attachCitations(readCell(doc, spec), doc));

    const duration = Date.now() - startTime;
    incrementMetric('matrix_column.success', { route: ROUTE, template: spec.key });
    recordTiming('matrix_column.latency', duration, { route: ROUTE });

    return {
      success: true,
      runId,
      column: { key: spec.key, label: spec.label, prompt: spec.prompt, format: spec.format },
      cells,
      summary: {
        documents: cells.length,
        flagged: cells.filter((c) => c.flag !== 'none').length,
        citations: cells.reduce((n, c) => n + c.citations.length, 0),
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
      tags: { route: ROUTE, service: SERVICE, template: column.templateKey },
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
      verticalLabel: 'Hebbia Matrix \u2014 Run column',
      customer: '7a925867',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'template', value: column.templateKey || '' },
      ],
      extra: { runId, matrixId: MATRIX.id, documents: DOCUMENTS.length },
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
  DOCUMENTS,
  COLUMN_TEMPLATES,
};
