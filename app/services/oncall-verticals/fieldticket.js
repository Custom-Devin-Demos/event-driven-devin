const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/fieldticket/approve';

/**
 * Commerce Central approval routing per product service line (PSL). Every
 * approved field ticket is priced against the PSL price book and posted to
 * the invoicing queue that owns it.
 */
const APPROVAL_ROUTING = {
  CEM: { psl: 'Cementing', priceBook: 'PB-CEM-2026-NAM', invoiceQueue: 'inv-cementing', invoiceHours: 24 },
  PE: { psl: 'Production Enhancement', priceBook: 'PB-PE-2026-NAM', invoiceQueue: 'inv-production-enhancement', invoiceHours: 24 },
  WPS: { psl: 'Wireline & Perforating', priceBook: 'PB-WPS-2026-NAM', invoiceQueue: 'inv-wireline', invoiceHours: 24 },
  BAR: { psl: 'Baroid', priceBook: 'PB-BAR-2026-NAM', invoiceQueue: 'inv-baroid', invoiceHours: 24 },
  SPY: { psl: 'Sperry Drilling', priceBook: 'PB-SPY-2026-NAM', invoiceQueue: 'inv-sperry', invoiceHours: 24 },
};

/**
 * Field tickets awaiting customer approval, as delivered by the
 * ft-sync@2026.11.10 field ticket sync from the field ERP.
 */
const FIELD_TICKETS = {
  'FT-4471093': {
    ticketNumber: 'FT-4471093', psl: 'PE-EF', service: 'ZEUS\u00ae electric fracturing \u2014 stages 1\u201318',
    well: 'Ridgeback State 14-2H', api: '42-389-40217', field: 'Delaware Basin', county: 'Reeves County, TX',
    jobDate: '2026-11-09', district: 'Pecos, TX',
    lines: [
      { item: 'ZEUS electric frac fleet \u2014 pumping service', qty: 18, unit: 'stage', rate: 38500 },
      { item: 'Proppant \u2014 100 mesh in-basin sand', qty: 7200000, unit: 'lb', rate: 0.032 },
      { item: 'SmartFleet\u00ae intelligent fracturing system', qty: 18, unit: 'stage', rate: 2400 },
      { item: 'Friction reducer \u2014 FR-66', qty: 21600, unit: 'gal', rate: 4.15 },
    ],
  },
  'FT-4470881': {
    ticketNumber: 'FT-4470881', psl: 'CEM', service: 'Production casing cement job',
    well: 'Ridgeback State 14-3H', api: '42-389-40218', field: 'Delaware Basin', county: 'Reeves County, TX',
    jobDate: '2026-11-07', district: 'Pecos, TX',
    lines: [
      { item: 'Cementing unit and crew', qty: 1, unit: 'job', rate: 18750 },
      { item: 'NeoCem\u2122 cement system', qty: 1450, unit: 'sk', rate: 31.5 },
      { item: 'Cement head and plug set', qty: 1, unit: 'ea', rate: 2950 },
    ],
  },
  'FT-4470612': {
    ticketNumber: 'FT-4470612', psl: 'WPS', service: 'Plug-and-perf wireline \u2014 stages 1\u201318',
    well: 'Ridgeback State 14-2H', api: '42-389-40217', field: 'Delaware Basin', county: 'Reeves County, TX',
    jobDate: '2026-11-08', district: 'Pecos, TX',
    lines: [
      { item: 'Wireline unit and crew', qty: 3, unit: 'day', rate: 9800 },
      { item: 'Perforating guns \u2014 3-1/8 in.', qty: 72, unit: 'gun', rate: 610 },
      { item: 'Composite frac plugs', qty: 17, unit: 'ea', rate: 1450 },
    ],
  },
  'FT-4469954': {
    ticketNumber: 'FT-4469954', psl: 'BAR', service: 'Drilling fluids \u2014 intermediate section',
    well: 'Ridgeback State 14-3H', api: '42-389-40218', field: 'Delaware Basin', county: 'Reeves County, TX',
    jobDate: '2026-11-04', district: 'Midland, TX',
    lines: [
      { item: 'BaraECD\u00ae high-performance fluid', qty: 1200, unit: 'bbl', rate: 64 },
      { item: 'Mud engineer', qty: 6, unit: 'day', rate: 1650 },
    ],
  },
};

function requestError(message, field) {
  const err = new Error(message);
  err.code = 'INVALID_REQUEST';
  err.status = 400;
  err.field = field;
  return err;
}

function text(value, max = 200) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeApproval(body) {
  const approval = {
    ticketNumber: text(body.ticketNumber, 20).toUpperCase(),
    approverName: text(body.approverName, 80),
    approverTitle: text(body.approverTitle, 80),
    poNumber: text(body.poNumber, 30).toUpperCase(),
    afeNumber: text(body.afeNumber, 30).toUpperCase(),
    comments: text(body.comments, 1000),
    acceptTerms: body.acceptTerms === true || body.acceptTerms === 'yes',
  };
  if (!approval.ticketNumber) throw requestError('Select a field ticket.', 'ticketNumber');
  if (!FIELD_TICKETS[approval.ticketNumber]) throw requestError('Field ticket not found.', 'ticketNumber');
  if (!approval.approverName) throw requestError('Approver name is required.', 'approverName');
  if (!approval.poNumber) throw requestError('PO number is required.', 'poNumber');
  if (!approval.acceptTerms) throw requestError('Confirm the services were performed as listed.', 'acceptTerms');
  return approval;
}

function ticketTotal(ticket) {
  return Math.round(ticket.lines.reduce((sum, l) => sum + l.qty * l.rate, 0) * 100) / 100;
}

function routeApproval(ticket) {
  const routing = APPROVAL_ROUTING[ticket.psl];
  return { psl: routing.psl, priceBook: routing.priceBook, invoiceQueue: routing.invoiceQueue, invoiceHours: routing.invoiceHours };
}

function approvalNumber(now) {
  const day = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `APR-${day}-${crypto.randomInt(10000, 100000)}`;
}

async function approveFieldTicket(body = {}) {
  const started = Date.now();
  const approval = normalizeApproval(body);
  const ticket = FIELD_TICKETS[approval.ticketNumber];
  const tags = [`route:${ROUTE}`, `psl:${ticket.psl}`];
  try {
    const routing = routeApproval(ticket);
    const now = new Date();
    incrementMetric('fieldticket.approve.success', tags);
    logger.info('Field ticket approved', { route: ROUTE, ticketNumber: ticket.ticketNumber, invoiceQueue: routing.invoiceQueue });
    return {
      success: true,
      approvalNumber: approvalNumber(now),
      approvedAt: now.toISOString(),
      ticketNumber: ticket.ticketNumber,
      well: ticket.well,
      total: ticketTotal(ticket),
      currency: 'USD',
      poNumber: approval.poNumber,
      routing,
    };
  } catch (error) {
    incrementMetric('fieldticket.approve.error', tags);
    logger.error('Field ticket approval failed', { route: ROUTE, ticketNumber: ticket.ticketNumber, psl: ticket.psl, error: error.message });
    Sentry.captureException(error, {
      tags: { vertical: 'fieldticket', route: ROUTE },
      extra: { ticketNumber: ticket.ticketNumber, psl: ticket.psl, well: ticket.well },
    });
    throw error;
  } finally {
    recordTiming('fieldticket.approve.duration', Date.now() - started, tags);
  }
}

module.exports = { approveFieldTicket, FIELD_TICKETS, APPROVAL_ROUTING, ticketTotal };
