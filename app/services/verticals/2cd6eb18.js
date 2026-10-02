const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/2cd6eb18/order-lines';
const SERVICE = 'fox-adsales-booking';

/**
 * Ad_Sales_Setting__mdt.Default — org-wide booking thresholds.
 */
const AD_SALES_SETTINGS = {
  approvalDiscountThreshold: 15,
  approvalGrossThreshold: 250000,
  sportsPremiumMultiplier: 1.25,
};

const PROGRAMS = {
  'NFL on FOX': { network: 'FOX', genre: 'Sports', isLiveSports: true },
  'MLB World Series': { network: 'FOX', genre: 'Sports', isLiveSports: true },
  'The Simpsons': { network: 'FOX', genre: 'Animation', isLiveSports: false },
  'Gutfeld!': { network: 'FOX News', genre: 'News', isLiveSports: false },
  'The Big Money Show': { network: 'FOX Business', genre: 'News', isLiveSports: false },
  'NASCAR Cup Series': { network: 'FS1', genre: 'Sports', isLiveSports: true },
};

const INVENTORY_SLOTS = {
  'INV-00005': { program: 'NFL on FOX', network: 'FOX', daypart: 'Live Sports', airDate: '2026-11-08', unitsAvailable: 10, unitsSold: 3, externalId: 'WO-AV-1001' },
  'INV-00006': { program: 'NFL on FOX', network: 'FOX', daypart: 'Live Sports', airDate: '2026-11-15', unitsAvailable: 6, unitsSold: 0, externalId: 'WO-AV-1002' },
  'INV-00007': { program: 'The Simpsons', network: 'FOX', daypart: 'Prime', airDate: '2026-10-18', unitsAvailable: 20, unitsSold: 0, externalId: 'WO-AV-1003' },
  'INV-00008': { program: 'The Simpsons', network: 'FOX', daypart: 'Prime', airDate: '2026-11-08', unitsAvailable: 20, unitsSold: 5, externalId: 'WO-AV-1004' },
  'INV-00009': { program: 'Gutfeld!', network: 'FOX News', daypart: 'Late Night', airDate: '2026-10-20', unitsAvailable: 30, unitsSold: 10, externalId: 'WO-AV-1005' },
  'INV-00010': { program: 'The Big Money Show', network: 'FOX Business', daypart: 'Daytime', airDate: '2026-10-21', unitsAvailable: 40, unitsSold: 8, externalId: 'WO-AV-1006' },
  'INV-00011': { program: 'NASCAR Cup Series', network: 'FS1', daypart: 'Live Sports', airDate: '2026-10-25', unitsAvailable: 12, unitsSold: 0, externalId: 'WO-AV-1007' },
  'INV-00012': { program: 'MLB World Series', network: 'FOX', daypart: 'Live Sports', airDate: '2026-10-27', unitsAvailable: 4, unitsSold: 0, externalId: 'WO-AV-1008' },
};

/**
 * Active Rate_Card__c rows, synced nightly from the FOX rate desk.
 *
 * The Q4 rate-desk export was cut over to the new per-network sheets in
 * September; FS1's sheet ships under the FOX Sports tab, so its cards are
 * loaded by the sports-rate backfill job instead of this sync.
 */
const RATE_CARDS = [
  { name: 'RC-0001', network: 'FOX', daypart: 'Live Sports', unitRate: 85000, effectiveStart: '2026-09-01', effectiveEnd: '2027-01-31', active: true },
  { name: 'RC-0002', network: 'FOX', daypart: 'Prime', unitRate: 42000, effectiveStart: '2026-09-01', effectiveEnd: '2026-12-31', active: true },
  { name: 'RC-0003', network: 'FOX News', daypart: 'Late Night', unitRate: 9500, effectiveStart: '2026-09-01', effectiveEnd: '2026-12-31', active: true },
  { name: 'RC-0004', network: 'FOX Business', daypart: 'Daytime', unitRate: 3200, effectiveStart: '2026-09-01', effectiveEnd: '2026-12-31', active: true },
  { name: 'RC-0006', network: 'FOX', daypart: 'Prime', unitRate: 39000, effectiveStart: '2026-06-01', effectiveEnd: '2026-08-31', active: false },
  { name: 'RC-0007', network: 'FOX', daypart: 'Prime', unitRate: 45000, effectiveStart: '2026-10-01', effectiveEnd: '2026-12-31', active: true },
];

const AD_ORDERS = {
  'AO-000010': {
    advertiser: 'Toyota Motor North America',
    agency: 'Horizon Media',
    agencyCommissionPct: 12,
    status: 'Draft',
    syncStatus: 'Not Synced',
    flightStart: '2026-10-15',
    flightEnd: '2026-11-30',
    lines: [
      { name: 'OL-000011', slot: 'INV-00005', units: 3, unitRate: 106250, discountPct: 0, gross: 318750, isSportsPremium: true, status: 'Booked' },
      { name: 'OL-000012', slot: 'INV-00008', units: 5, unitRate: 45000, discountPct: 10, gross: 202500, isSportsPremium: false, status: 'Booked' },
    ],
  },
  'AO-000011': {
    advertiser: 'Anheuser-Busch',
    agency: null,
    agencyCommissionPct: 0,
    status: 'Draft',
    syncStatus: 'Not Synced',
    flightStart: '2026-10-01',
    flightEnd: '2026-10-31',
    lines: [
      { name: 'OL-000013', slot: 'INV-00009', units: 10, unitRate: 9500, discountPct: 20, gross: 76000, isSportsPremium: false, status: 'Booked' },
      { name: 'OL-000014', slot: 'INV-00010', units: 8, unitRate: 3200, discountPct: 0, gross: 25600, isSportsPremium: false, status: 'Booked' },
    ],
  },
};

let nextLineNumber = 15;

function roundCurrency(n) {
  return Math.round(n * 100) / 100;
}

function selectRateCard(slot) {
  return RATE_CARDS
    .filter((rc) => rc.active
      && rc.network === slot.network
      && rc.daypart === slot.daypart
      && rc.effectiveStart <= slot.airDate
      && rc.effectiveEnd >= slot.airDate)
    .sort((a, b) => b.effectiveStart.localeCompare(a.effectiveStart))[0];
}

function priceLine(slot, rateCard, units, discountPct) {
  const isSportsPremium = slot.daypart === 'Live Sports';
  const multiplier = isSportsPremium ? AD_SALES_SETTINGS.sportsPremiumMultiplier : 1;
  const unitRate = roundCurrency(rateCard.unitRate * multiplier);
  const gross = roundCurrency(unitRate * units * (1 - discountPct / 100));
  return { rateCard: rateCard.name, unitRate, gross, isSportsPremium };
}

function rollupOrder(order, newLine) {
  const lines = newLine ? [...order.lines, newLine] : order.lines;
  const totalGross = roundCurrency(lines.reduce((sum, l) => sum + l.gross, 0));
  const netAmount = roundCurrency(totalGross * (1 - order.agencyCommissionPct / 100));
  const maxDiscountPct = Math.max(...lines.map((l) => l.discountPct || 0));
  const reasons = [];
  if (totalGross > AD_SALES_SETTINGS.approvalGrossThreshold) reasons.push(`Total gross exceeds $${AD_SALES_SETTINGS.approvalGrossThreshold.toLocaleString('en-US')}`);
  if (maxDiscountPct > AD_SALES_SETTINGS.approvalDiscountThreshold) reasons.push(`Discount exceeds ${AD_SALES_SETTINGS.approvalDiscountThreshold}%`);
  return {
    lineCount: lines.length,
    totalGross,
    netAmount,
    maxDiscountPct,
    requiresApproval: reasons.length > 0,
    approvalReason: reasons.join('; ') || null,
  };
}

async function bookOrderLine(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const order = AD_ORDERS[data.orderNumber];
  const slot = INVENTORY_SLOTS[data.slotName];

  logger.info('FOX Ad Sales order line booking started', {
    requestId,
    orderNumber: data.orderNumber,
    slotName: data.slotName,
    network: slot.network,
    daypart: slot.daypart,
    units: data.units,
    service: SERVICE,
  });

  try {
    const rateCard = selectRateCard(slot);
    const pricing = priceLine(slot, rateCard, data.units, data.discountPct);
    const lineName = `OL-${String(nextLineNumber++).padStart(6, '0')}`;
    const line = {
      name: lineName,
      slot: data.slotName,
      units: data.units,
      unitRate: pricing.unitRate,
      discountPct: data.discountPct,
      gross: pricing.gross,
      isSportsPremium: pricing.isSportsPremium,
      status: 'Booked',
    };
    const rollup = rollupOrder(order, line);

    incrementMetric('order_line.book.success', { route: ROUTE, network: slot.network, daypart: slot.daypart });
    recordTiming('order_line.book.latency', Date.now() - startTime, { route: ROUTE });
    logger.info('FOX Ad Sales order line booked', {
      requestId,
      orderNumber: data.orderNumber,
      lineName,
      rateCard: pricing.rateCard,
      gross: pricing.gross,
      service: SERVICE,
    });

    return {
      success: true,
      requestId,
      orderNumber: data.orderNumber,
      line: {
        ...line,
        rateCard: pricing.rateCard,
        program: slot.program,
        network: slot.network,
        daypart: slot.daypart,
        airDate: slot.airDate,
      },
      order: { ...rollup, status: order.status },
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order_line.book.failure', {
      route: ROUTE,
      errorClass: error.name,
      network: slot.network,
      daypart: slot.daypart,
    });
    recordTiming('order_line.book.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('FOX Ad Sales order line booking failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      orderNumber: data.orderNumber,
      slotName: data.slotName,
      network: slot.network,
      daypart: slot.daypart,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'fox-adsales-booking', network: slot.network, daypart: slot.daypart, alert_path: 'instant' },
      extra: {
        requestId,
        orderNumber: data.orderNumber,
        slotName: data.slotName,
        program: slot.program,
        units: data.units,
        discountPct: data.discountPct,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/2cd6eb18.js \u2014 priceLine',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '2cd6eb18',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'FOX Ad Sales \u2014 Order Line Booking',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'network', value: slot.network },
        { key: 'daypart', value: slot.daypart },
      ],
      extra: {
        requestId,
        orderNumber: data.orderNumber,
        slotName: data.slotName,
        program: slot.program,
        units: data.units,
      },
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
      logger.error('Failed to trigger Devin session from FOX Ad Sales booking error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  bookOrderLine,
  selectRateCard,
  priceLine,
  rollupOrder,
  AD_SALES_SETTINGS,
  PROGRAMS,
  INVENTORY_SLOTS,
  RATE_CARDS,
  AD_ORDERS,
};
