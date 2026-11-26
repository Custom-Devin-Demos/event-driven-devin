const { createHash } = require('crypto');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const CUSTOMER = '7c9d826f';
const SERVICE = 'customer-7c9d826f-einvoice-pl';
const ROUTE = 'POST /api/7c9d826f/documents/:id/submit';
const CULPRIT = 'app/services/verticals/7c9d826f.js — buyerFlags';
const SCHEMA = 'FA(3)';
const ALERT_COOLDOWN_MS = Number(process.env.SOVOS_EINVOICE_ALERT_COOLDOWN_MS) || 60 * 1000;
const lastAlertAt = new Map();

// Synthetic issuer and buyers. No real taxpayer data.
const SELLER = { name: 'Halden Industrial Sp. z o.o.', nip: '5260001246', address: 'ul. Fabryczna 14, 00-446 Warszawa' };
const DOCUMENTS = [
  { id: 'FV-2026-11-0412', issueDate: '2026-11-24', currency: 'PLN', status: 'authorized', ksefNumber: '5260001246-20261124-0A41C7-3F',
    buyer: { name: 'Baltica Logistics S.A.', nip: '5830003937', address: 'ul. Portowa 3, 81-339 Gdynia' },
    lines: [{ name: 'Hydraulic pump HP-220', quantity: 4, unitNet: 6850, vatRate: 23 }] },
  { id: 'FV-2026-11-0413', issueDate: '2026-11-25', currency: 'PLN', status: 'authorized', ksefNumber: '5260001246-20261125-0B77D2-91',
    buyer: { name: 'Meblostal Sp. z o.o.', nip: '7790011427', address: 'ul. Garbary 60, 61-758 Poznań' },
    lines: [{ name: 'Linear actuator LA-80', quantity: 12, unitNet: 1240, vatRate: 23 }] },
  { id: 'FV-2026-11-0414', issueDate: '2026-11-26', currency: 'PLN', status: 'pending',
    buyer: { name: 'Vistula Energia Grupa VAT', nip: '6750000384', address: 'al. Pokoju 1, 31-548 Kraków', vatGroupMember: true },
    lines: [{ name: 'Control cabinet CC-900', quantity: 2, unitNet: 48200, vatRate: 23 }, { name: 'On-site commissioning', quantity: 1, unitNet: 9600, vatRate: 23 }] },
  { id: 'FV-2026-11-0415', issueDate: '2026-11-26', currency: 'PLN', status: 'pending',
    buyer: { name: 'Odra Components Sp. z o.o.', nip: '8990020923', address: 'ul. Legnicka 48, 54-202 Wrocław' },
    lines: [{ name: 'Servo drive SD-45', quantity: 6, unitNet: 3980, vatRate: 23 }] },
];

const REMEDIATION_DIRECTIVE = [
  'Investigate and fix COG-GTM/event-driven-devin. Open a pull request against main; do not merge or deploy.',
  'Sovos-styled Compliance Network demo (/sovos-einvoice or /7c9d826f): sending Poland invoice FV-2026-11-0414 to the tax authority is rejected.',
  'Reproduce: open /sovos-einvoice, select FV-2026-11-0414 (buyer is a VAT group member) and choose Send to tax authority. FV-2026-11-0415 is authorized.',
  'Inspect app/services/verticals/7c9d826f.js (mapToFa3, buyerFlags, validateFa3) and app/routes/verticals/7c9d826f.js.',
  'Establish the root cause from the rejection and the mapping code, and state which buyers are affected.',
  'Keep validateFa3 as strict as it is; it stands in for the tax authority and must not be relaxed.',
  'Add regression coverage in tests/7c9d826f-einvoice.test.js and update the planted-failure expectation after the fix.',
  'Do not disable Sentry/alerts, swallow the rejection, or fake an authorization in the browser.',
].join('\n');

const round2 = n => Math.round(n * 100) / 100;
const invalid = (message, status = 400, code = 'INVALID_DOCUMENT') => Object.assign(new Error(message), { name: 'ValidationError', status, code });

function totals(doc) {
  const net = round2(doc.lines.reduce((sum, l) => sum + l.quantity * l.unitNet, 0));
  const vat = round2(doc.lines.reduce((sum, l) => sum + l.quantity * l.unitNet * l.vatRate / 100, 0));
  return { net, vat, gross: round2(net + vat) };
}

// FA(3) buyer markers: 1 = applies, 2 = does not apply.
function buyerFlags(buyer) {
  if (buyer.vatGroupMember) return { GV: 1 };
  if (buyer.localGovernmentUnit) return { JST: 1 };
  return { JST: 2, GV: 2 };
}

function mapToFa3(doc) {
  const t = totals(doc);
  return {
    Naglowek: { KodFormularza: 'FA', WariantFormularza: 3, DataWytworzeniaFa: `${doc.issueDate}T08:00:00Z` },
    Podmiot1: { DaneIdentyfikacyjne: { NIP: SELLER.nip, Nazwa: SELLER.name }, Adres: { KodKraju: 'PL', AdresL1: SELLER.address } },
    Podmiot2: { DaneIdentyfikacyjne: { NIP: doc.buyer.nip, Nazwa: doc.buyer.name }, Adres: { KodKraju: 'PL', AdresL1: doc.buyer.address }, ...buyerFlags(doc.buyer) },
    Fa: {
      KodWaluty: doc.currency, P_1: doc.issueDate, P_2: doc.id, P_13_1: t.net, P_14_1: t.vat, P_15: t.gross,
      FaWiersz: doc.lines.map((l, i) => ({ NrWierszaFa: i + 1, P_7: l.name, P_8B: l.quantity, P_9A: l.unitNet, P_11: round2(l.quantity * l.unitNet), P_12: l.vatRate })),
    },
  };
}

// Stand-in for the tax authority's FA(3) schema check. Both buyer markers are required on every invoice.
function validateFa3(xml) {
  const errors = [];
  if (xml.Naglowek.WariantFormularza !== 3) errors.push({ path: 'Naglowek/WariantFormularza', message: 'Expected value 3.' });
  for (const party of ['Podmiot1', 'Podmiot2']) {
    if (!/^\d{10}$/.test(xml[party].DaneIdentyfikacyjne.NIP)) errors.push({ path: `${party}/DaneIdentyfikacyjne/NIP`, message: 'NIP must be 10 digits.' });
  }
  for (const flag of ['JST', 'GV']) {
    if (![1, 2].includes(xml.Podmiot2[flag])) errors.push({ path: `Podmiot2/${flag}`, message: `Required element '${flag}' is missing. Allowed values: 1, 2.` });
  }
  if (!xml.Fa.FaWiersz.length) errors.push({ path: 'Fa/FaWiersz', message: 'At least one invoice line is required.' });
  if (round2(xml.Fa.P_13_1 + xml.Fa.P_14_1) !== xml.Fa.P_15) errors.push({ path: 'Fa/P_15', message: 'Gross amount does not equal net plus VAT.' });
  return errors;
}

function summarize(doc) {
  return { id: doc.id, issueDate: doc.issueDate, currency: doc.currency, status: doc.status, ksefNumber: doc.ksefNumber || null,
    country: 'PL', documentType: 'Invoice', schema: SCHEMA, seller: SELLER, buyer: { name: doc.buyer.name, nip: doc.buyer.nip, address: doc.buyer.address },
    lines: doc.lines, totals: totals(doc) };
}
const listDocuments = () => DOCUMENTS.map(summarize);

async function submitDocument(data = {}) {
  const doc = typeof data.documentId === 'string' ? DOCUMENTS.find(d => d.id === data.documentId) : undefined;
  if (!doc) throw invalid('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  if (doc.status !== 'pending') throw invalid('This document has already been authorized.', 409, 'ALREADY_AUTHORIZED');
  const xml = mapToFa3(doc);
  const errors = validateFa3(xml);
  if (!errors.length) {
    const ksefNumber = `${SELLER.nip}-${doc.issueDate.replace(/-/g, '')}-${createHash('sha256').update(doc.id).digest('hex').slice(0, 6).toUpperCase()}-7C`;
    logger.info('Poland e-invoice authorized', { service: SERVICE, documentId: doc.id });
    return { success: true, document: { ...summarize(doc), status: 'authorized', ksefNumber }, authorizedAt: new Date().toISOString() };
  }
  const first = errors[0];
  const error = Object.assign(new Error(`KSeF rejected ${doc.id}: document does not conform to schema ${SCHEMA} (${first.path}: ${first.message})`), {
    name: 'TaxAuthorityRejection', status: 422, code: 'TAX_AUTHORITY_REJECTED',
    rejection: { authority: 'KSeF', schema: SCHEMA, errors, rejectedAt: new Date().toISOString() },
  });
  const context = { documentId: doc.id, country: 'PL', schema: SCHEMA, buyerNip: doc.buyer.nip, vatGroupMember: Boolean(doc.buyer.vatGroupMember), schemaErrors: errors };
  const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' };
  Sentry.captureException(error, { tags, extra: context });
  logger.error('Poland e-invoice rejected by tax authority', { ...context, service: SERVICE, error: error.message });
  const presenter = data.devinUserId || data.devinEmail || 'shared';
  if (Date.now() - (lastAlertAt.get(presenter) || 0) < ALERT_COOLDOWN_MS) {
    logger.info('Sovos e-invoice alert suppressed by cooldown', { service: SERVICE, documentId: doc.id, cooldownMs: ALERT_COOLDOWN_MS });
    throw error;
  }
  lastAlertAt.set(presenter, Date.now());
  logger.info('Posting alert and triggering Devin', { service: SERVICE, documentId: doc.id });
  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: CULPRIT, errorType: error.name, errorValue: error.message,
    customer: CUSTOMER, service: SERVICE, verticalLabel: 'Sovos — Compliance Network (Poland)',
    level: 'error', platform: 'node',
    devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
    promptAppendix: REMEDIATION_DIRECTIVE, skipVulnerablePr: true,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
  }).then(result => { if (!result) lastAlertAt.delete(presenter); }).catch(err => { lastAlertAt.delete(presenter); logger.error('Failed to create Devin session for Sovos e-invoice demo', { error: err.message, documentId: doc.id }); });
  throw error;
}

const resetAlertCooldown = () => lastAlertAt.clear();

module.exports = { resetAlertCooldown, CUSTOMER, SERVICE, ROUTE, CULPRIT, SCHEMA, DOCUMENTS, REMEDIATION_DIRECTIVE, totals, buyerFlags, mapToFa3, validateFa3, listDocuments, submitDocument };
