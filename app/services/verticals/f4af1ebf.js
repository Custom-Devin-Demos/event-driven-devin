const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.TRANSFLO_SLACK_MEMBER_ID || 'U0B7F46NVA4';
const SERVICE = 'transflo-workflow-ai';
const ROUTE = '/api/f4af1ebf/billing/submit';

// Minimum OCR confidence for an extracted field to be trusted on a billing packet.
const FIELD_CONFIDENCE_FLOOR = 0.62;

const CARRIER = { scac: 'SGFL', name: 'Saguaro Freight Lines', terminal: 'Phoenix, AZ' };

const LOADS = [
  {
    id: 'TF-48213', ref: 'PO 77120-A', shipper: 'Desert Sun Produce', origin: 'Yuma, AZ',
    consignee: 'Kroger DC 641', destination: 'Tolleson, AZ', driver: 'M. Castillo', unit: 'TRK 2217',
    delivered: '2026-10-13T06:42:00-07:00', miles: 189, lineHaul: 1265.0, accessorials: 95.0, status: 'Delivered',
    documents: [
      {
        id: 'DOC-91402', type: 'BOL', title: 'Bill of Lading', source: 'mobile_capture', pages: 1,
        capturedAt: '2026-10-12T19:08:00-07:00', capturedBy: 'Transflo Mobile+ (Android)',
        extracted: {
          bolNumber: { value: '771200441', confidence: 0.98 },
          shipper: { value: 'Desert Sun Produce', confidence: 0.97 },
          consignee: { value: 'Kroger DC 641', confidence: 0.96 },
          pieces: { value: 24, confidence: 0.94 },
          weight: { value: 41260, confidence: 0.93 },
          signature: { value: 'J. Reyes (shipper)', signedAt: '2026-10-12T19:05:00-07:00', confidence: 0.91 },
        },
      },
      {
        id: 'DOC-91417', type: 'POD', title: 'Proof of Delivery', source: 'mobile_capture', pages: 2,
        capturedAt: '2026-10-13T06:51:00-07:00', capturedBy: 'Transflo Mobile+ (Android)',
        captureNote: 'Low-light capture at receiver dock door 14',
        extracted: {
          bolNumber: { value: '771200441', confidence: 0.95 },
          consignee: { value: 'Kroger DC 641', confidence: 0.92 },
          pieces: { value: 24, confidence: 0.88 },
          weight: { value: 41260, confidence: 0.86 },
          deliveredAt: { value: '2026-10-13T06:42:00-07:00', confidence: 0.83 },
          signature: { value: 'Receiving clerk', signedAt: '2026-10-13T06:44:00-07:00', confidence: 0.41 },
        },
      },
      {
        id: 'DOC-91421', type: 'LUMPER', title: 'Lumper Receipt', source: 'mobile_capture', pages: 1,
        capturedAt: '2026-10-13T06:55:00-07:00', capturedBy: 'Transflo Mobile+ (Android)',
        extracted: {
          vendor: { value: 'Capstone Logistics', confidence: 0.96 },
          amount: { value: 95.0, confidence: 0.97 },
          receiptNumber: { value: 'CL-5582901', confidence: 0.9 },
        },
      },
    ],
  },
  {
    id: 'TF-48207', ref: 'PO 310-88451', shipper: 'Copperstate Steel', origin: 'Tucson, AZ',
    consignee: 'Nucor Fabrication', destination: 'Riverside, CA', driver: 'T. Nguyen', unit: 'TRK 2104',
    delivered: '2026-10-13T11:15:00-07:00', miles: 486, lineHaul: 2310.0, accessorials: 0, status: 'Delivered',
    documents: [
      {
        id: 'DOC-91388', type: 'BOL', title: 'Bill of Lading', source: 'scanner', pages: 1,
        capturedAt: '2026-10-12T15:20:00-07:00', capturedBy: 'Transflo Express (Pilot #187)',
        extracted: {
          bolNumber: { value: '31088451', confidence: 0.99 },
          shipper: { value: 'Copperstate Steel', confidence: 0.98 },
          consignee: { value: 'Nucor Fabrication', confidence: 0.97 },
          pieces: { value: 12, confidence: 0.96 },
          weight: { value: 44800, confidence: 0.96 },
          signature: { value: 'D. Olsen (shipper)', signedAt: '2026-10-12T15:02:00-07:00', confidence: 0.9 },
        },
      },
      {
        id: 'DOC-91436', type: 'POD', title: 'Proof of Delivery', source: 'mobile_capture', pages: 1,
        capturedAt: '2026-10-13T11:22:00-07:00', capturedBy: 'Transflo Mobile+ (iOS)',
        extracted: {
          bolNumber: { value: '31088451', confidence: 0.97 },
          consignee: { value: 'Nucor Fabrication', confidence: 0.95 },
          pieces: { value: 12, confidence: 0.94 },
          weight: { value: 44800, confidence: 0.93 },
          deliveredAt: { value: '2026-10-13T11:15:00-07:00', confidence: 0.9 },
          signature: { value: 'R. Patel (receiving)', signedAt: '2026-10-13T11:18:00-07:00', confidence: 0.89 },
        },
      },
    ],
  },
  {
    id: 'TF-48199', ref: 'PO 55-2201', shipper: 'Sonoran Beverage Co.', origin: 'Tempe, AZ',
    consignee: 'Costco Depot 1061', destination: 'Las Vegas, NV', driver: 'A. Whitehorse', unit: 'TRK 2290',
    delivered: '2026-10-12T22:05:00-07:00', miles: 298, lineHaul: 1540.0, accessorials: 150.0, status: 'Delivered',
    documents: [
      {
        id: 'DOC-91350', type: 'BOL', title: 'Bill of Lading', source: 'edi', pages: 1,
        capturedAt: '2026-10-12T13:00:00-07:00', capturedBy: 'EDI 211 (shipper)',
        extracted: {
          bolNumber: { value: '552201003', confidence: 1 },
          shipper: { value: 'Sonoran Beverage Co.', confidence: 1 },
          consignee: { value: 'Costco Depot 1061', confidence: 1 },
          pieces: { value: 26, confidence: 1 },
          weight: { value: 42110, confidence: 1 },
          signature: { value: 'EDI acknowledgment', signedAt: '2026-10-12T13:00:00-07:00', confidence: 1 },
        },
      },
      {
        id: 'DOC-91372', type: 'POD', title: 'Proof of Delivery', source: 'mobile_capture', pages: 1,
        capturedAt: '2026-10-12T22:11:00-07:00', capturedBy: 'Transflo Mobile+ (Android)',
        extracted: {
          bolNumber: { value: '552201003', confidence: 0.96 },
          consignee: { value: 'Costco Depot 1061', confidence: 0.95 },
          pieces: { value: 26, confidence: 0.92 },
          weight: { value: 42110, confidence: 0.9 },
          deliveredAt: { value: '2026-10-12T22:05:00-07:00', confidence: 0.88 },
          signature: { value: 'K. Lam (receiving)', signedAt: '2026-10-12T22:08:00-07:00', confidence: 0.87 },
        },
      },
      {
        id: 'DOC-91374', type: 'DETENTION', title: 'Detention Log', source: 'mobile_capture', pages: 1,
        capturedAt: '2026-10-12T22:14:00-07:00', capturedBy: 'Transflo Mobile+ (Android)',
        extracted: {
          arrivedAt: { value: '2026-10-12T18:40:00-07:00', confidence: 0.9 },
          departedAt: { value: '2026-10-12T22:10:00-07:00', confidence: 0.9 },
          amount: { value: 150.0, confidence: 0.93 },
        },
      },
    ],
  },
  {
    id: 'TF-48190', ref: 'PO 9931-17', shipper: 'Grand Canyon Paper', origin: 'Flagstaff, AZ',
    consignee: 'Staples Fulfillment', destination: 'Albuquerque, NM', driver: 'R. Begay', unit: 'TRK 2088',
    delivered: '2026-10-12T16:30:00-07:00', miles: 325, lineHaul: 1420.0, accessorials: 0, status: 'Billed',
    documents: [
      {
        id: 'DOC-91301', type: 'BOL', title: 'Bill of Lading', source: 'scanner', pages: 1,
        capturedAt: '2026-10-12T08:12:00-07:00', capturedBy: 'Transflo Express (Love\u2019s #412)',
        extracted: {
          bolNumber: { value: '993117008', confidence: 0.98 },
          shipper: { value: 'Grand Canyon Paper', confidence: 0.98 },
          consignee: { value: 'Staples Fulfillment', confidence: 0.97 },
          pieces: { value: 18, confidence: 0.95 },
          weight: { value: 38900, confidence: 0.95 },
          signature: { value: 'L. Moreno (shipper)', signedAt: '2026-10-12T08:01:00-07:00', confidence: 0.92 },
        },
      },
      {
        id: 'DOC-91333', type: 'POD', title: 'Proof of Delivery', source: 'mobile_capture', pages: 1,
        capturedAt: '2026-10-12T16:37:00-07:00', capturedBy: 'Transflo Mobile+ (iOS)',
        extracted: {
          bolNumber: { value: '993117008', confidence: 0.97 },
          consignee: { value: 'Staples Fulfillment', confidence: 0.96 },
          pieces: { value: 18, confidence: 0.94 },
          weight: { value: 38900, confidence: 0.93 },
          deliveredAt: { value: '2026-10-12T16:30:00-07:00', confidence: 0.91 },
          signature: { value: 'S. Ortiz (receiving)', signedAt: '2026-10-12T16:33:00-07:00', confidence: 0.9 },
        },
      },
    ],
  },
  {
    id: 'TF-48221', ref: 'PO 4471-B', shipper: 'Mesa Cold Storage', origin: 'Mesa, AZ',
    consignee: 'Sprouts DC', destination: 'Glendale, AZ', driver: 'M. Castillo', unit: 'TRK 2217',
    delivered: null, miles: 32, lineHaul: 410.0, accessorials: 0, status: 'In Transit',
    documents: [
      {
        id: 'DOC-91450', type: 'BOL', title: 'Bill of Lading', source: 'mobile_capture', pages: 1,
        capturedAt: '2026-10-13T13:02:00-07:00', capturedBy: 'Transflo Mobile+ (Android)',
        extracted: {
          bolNumber: { value: '44710029', confidence: 0.97 },
          shipper: { value: 'Mesa Cold Storage', confidence: 0.97 },
          consignee: { value: 'Sprouts DC', confidence: 0.95 },
          pieces: { value: 20, confidence: 0.93 },
          weight: { value: 36400, confidence: 0.92 },
          signature: { value: 'P. Diaz (shipper)', signedAt: '2026-10-13T12:58:00-07:00', confidence: 0.9 },
        },
      },
    ],
  },
];

class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = code;
  }
}

function findLoad(loadId) {
  const load = LOADS.find((l) => l.id === loadId);
  if (!load) throw new ValidationError(`Load ${loadId} not found`, 'LOAD_NOT_FOUND');
  return load;
}

function findDocument(load, documentId) {
  const doc = load.documents.find((d) => d.id === documentId);
  if (!doc) throw new ValidationError(`Document ${documentId} not on load ${load.id}`, 'DOCUMENT_NOT_FOUND');
  return doc;
}

function summarizeDocument(doc) {
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    source: doc.source,
    pages: doc.pages,
    capturedAt: doc.capturedAt,
    capturedBy: doc.capturedBy,
    captureNote: doc.captureNote || null,
    fieldCount: Object.keys(doc.extracted).length,
  };
}

function listLoads() {
  return {
    carrier: CARRIER,
    loads: LOADS.map((load) => ({
      ...load,
      documents: load.documents.map(summarizeDocument),
    })),
  };
}

function extractedFieldList(doc) {
  return Object.entries(doc.extracted).map(([key, field]) => ({
    key,
    label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
    value: field.value,
    confidence: field.confidence,
    review: field.confidence < FIELD_CONFIDENCE_FLOOR,
  }));
}

async function indexDocument(data) {
  const load = findLoad(data.loadId);
  const doc = findDocument(load, data.documentId);
  const startTime = Date.now();

  await new Promise((resolve) => setTimeout(resolve, 900 + Math.random() * 600));

  const fields = extractedFieldList(doc);
  recordTiming('document_index.latency', Date.now() - startTime, { route: '/api/f4af1ebf/documents/index' });
  incrementMetric('document_index.success', { docType: doc.type, source: doc.source });

  return {
    success: true,
    document: summarizeDocument(doc),
    fields,
    needsReview: fields.filter((f) => f.review).map((f) => f.key),
  };
}

/**
 * Normalizes OCR output into the flat field map the billing packet expects.
 * Fields below the confidence floor are left out so a human reviews them
 * downstream instead of a low-confidence value flowing onto an invoice.
 */
function normalizeExtractedFields(doc) {
  const normalized = {};
  Object.entries(doc.extracted).forEach(([key, field]) => {
    if (field.confidence < FIELD_CONFIDENCE_FLOOR) return;
    normalized[key] = key === 'signature'
      ? { signedBy: field.value, signedAt: field.signedAt }
      : field.value;
  });
  return normalized;
}

function buildBillingPacket(load, doc, fields) {
  const total = load.lineHaul + load.accessorials;
  return {
    packetId: `PKT-${load.id}-${doc.id.slice(-5)}`,
    loadId: load.id,
    carrier: CARRIER.scac,
    billTo: load.shipper,
    bolNumber: fields.bolNumber,
    deliveredAt: fields.deliveredAt || load.delivered,
    receivedBy: fields.signature.signedBy,
    signedAt: new Date(fields.signature.signedAt).toISOString(),
    pieces: fields.pieces,
    weight: fields.weight,
    lineHaul: load.lineHaul,
    accessorials: load.accessorials,
    total,
    documents: load.documents.map((d) => d.id),
  };
}

async function submitToBilling(data) {
  const runId = uuidv4();
  const startTime = Date.now();
  const load = findLoad(data.loadId);
  const doc = findDocument(load, data.documentId);

  if (doc.type !== 'POD') {
    throw new ValidationError('Only a Proof of Delivery can be submitted to billing', 'POD_REQUIRED');
  }

  logger.info('Submitting POD to billing', {
    runId, loadId: load.id, documentId: doc.id, source: doc.source, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 600));

    const fields = normalizeExtractedFields(doc);
    const packet = buildBillingPacket(load, doc, fields);

    const duration = Date.now() - startTime;
    incrementMetric('billing_submit.success', { route: ROUTE, source: doc.source });
    recordTiming('billing_submit.latency', duration, { route: ROUTE });

    return {
      success: true,
      runId,
      packet,
      invoice: { number: `INV-${load.id.replace('TF-', '')}`, status: 'Queued for TMS export', amount: packet.total },
    };
  } catch (error) {
    if (error.name === 'ValidationError') throw error;

    const duration = Date.now() - startTime;
    incrementMetric('billing_submit.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('billing_submit.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Billing submit failed', {
      runId, loadId: load.id, documentId: doc.id, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, docType: doc.type, source: doc.source, alert_path: 'instant' },
      extra: { runId, loadId: load.id, documentId: doc.id },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f4af1ebf.js \u2014 buildBillingPacket',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Transflo Workflow AI \u2014 Submit POD to billing',
      customer: 'f4af1ebf',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'loadId', value: load.id },
        { key: 'documentId', value: doc.id },
        { key: 'source', value: doc.source },
        { key: 'alert_path', value: 'instant' },
      ],
      extra: { runId, loadId: load.id, documentId: doc.id, capturedBy: doc.capturedBy },
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
      logger.error('Failed to create Devin session for billing submit error', { error: err.message, runId });
    });

    error.requestId = runId;
    throw error;
  }
}

module.exports = {
  listLoads,
  indexDocument,
  submitToBilling,
  LOADS,
};
