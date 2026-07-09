const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Louis Dreyfus Company (Brazil) physical commodity book.
 * Flat prices are quoted in USD per metric tonne, FOB Brazilian ports.
 */
const COMMODITIES = [
  { id: 'SOYBEAN-BR', name: 'Soybeans', grade: 'FOB Santos No.2', unit: 'MT', flatPrice: 428.5, currency: 'USD' },
  { id: 'SOYMEAL-BR', name: 'Soybean Meal', grade: 'Hi-Pro 46%', unit: 'MT', flatPrice: 392.0, currency: 'USD' },
  { id: 'CORN-BR', name: 'Corn', grade: 'FOB Paranagua', unit: 'MT', flatPrice: 214.75, currency: 'USD' },
  { id: 'SUGAR-VHP', name: 'Raw Sugar (VHP)', grade: '45 ICUMSA', unit: 'MT', flatPrice: 512.3, currency: 'USD' },
  { id: 'COFFEE-ARB', name: 'Arabica Coffee', grade: 'Santos 4/5', unit: 'MT', flatPrice: 6420.0, currency: 'USD' },
  { id: 'COTTON-BR', name: 'Cotton', grade: 'Middling 1-1/8', unit: 'MT', flatPrice: 1685.0, currency: 'USD' },
];

/**
 * Export terminals (ports) and their basis differential over the flat price.
 * Basis is expressed in USD per metric tonne on top of the commodity flat price.
 */
const EXPORT_TERMINALS = {
  santos: { label: 'Porto de Santos', basis: 12.5, currency: 'USD' },
  paranagua: { label: 'Porto de Paranagua', basis: 9.75, currency: 'USD' },
  rio_grande: { label: 'Porto do Rio Grande', basis: 8.0, currency: 'USD' },
  itaqui: { label: 'Porto do Itaqui (Maranhao)', basis: 15.25, currency: 'USD' },
};

/**
 * Mandatory documentary line automatically appended to every export contract so
 * that SISCOMEX/despacho aduaneiro fees are booked alongside the physical volume.
 */
const CONTRACT_LINES = [
  { sku: 'LDC-EXPORT-DOC-2026', qty: 1, price: 0 },
];

/**
 * Demurrage tiers applied on top of contract value, scaled by the lot size.
 */
function getDemurrageTier(volumeMt) {
  if (volumeMt >= 25000) return { rate: 0.0, label: 'Panamax priority (waived)' };
  if (volumeMt >= 10000) return { rate: 0.008, label: 'Handysize allocation' };
  return { rate: 0.015, label: 'Coaster / partial lot' };
}

/**
 * Appends the mandatory documentary line to the traded volume.
 */
function applyContractLines(lots) {
  return [...lots, ...CONTRACT_LINES];
}

/**
 * Prices a physical export contract for a given terminal.
 */
function priceContract(contractValue, volumeMt, terminalId) {
  const terminal = EXPORT_TERMINALS[terminalId];
  if (!terminal) {
    throw Object.assign(new Error(`Unknown export terminal: ${terminalId}`), { code: 'INVALID_TERMINAL' });
  }
  const basisAdj = volumeMt * terminal.basis;
  const demurrage = getDemurrageTier(volumeMt);
  const demurrageFee = (contractValue + basisAdj) * demurrage.rate;
  return {
    contractValue,
    basisAdj: Math.round(basisAdj * 100) / 100,
    demurrageFee: Math.round(demurrageFee * 100) / 100,
    demurrageLabel: demurrage.label,
    total: Math.round((contractValue + basisAdj + demurrageFee) * 100) / 100,
    currency: terminal.currency,
    terminal: terminal.label,
  };
}

/**
 * Builds the contract confirmation manifest.
 * BUG: LDC-EXPORT-DOC-2026 is not in COMMODITIES, so commodity.name crashes with a TypeError.
 */
function formatContractLines(allLots) {
  return allLots.map((lot) => {
    const commodity = COMMODITIES.find((c) => c.id === lot.sku);
    return {
      sku: lot.sku,
      name: commodity.name,
      grade: commodity.grade,
      qty: lot.qty,
      lineValue: lot.price * lot.qty,
    };
  });
}

/**
 * Books a physical commodity export contract for LDC Brazil.
 */
async function bookTrade(tradeData) {
  const startTime = Date.now();
  const tradeId = uuidv4();

  logger.info('Booking LDC Brazil export contract', {
    tradeId,
    trader: tradeData.trader,
    volumeMt: tradeData.volumeMt,
    service: 'ldc-brazil-trade',
    route: '/api/a1e178ae/book',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allLots = applyContractLines(tradeData.lots);

    const contractValue = tradeData.lots.reduce(
      (sum, lot) => sum + lot.price * lot.qty,
      0,
    ) || tradeData.contractValue;

    const result = priceContract(contractValue, tradeData.volumeMt, tradeData.terminal);
    const lines = formatContractLines(allLots);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/a1e178ae/book',
      source: 'ldc-brazil-trade-desk',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/a1e178ae/book',
    });

    return {
      success: true,
      tradeId,
      total: result.total,
      basisAdj: result.basisAdj,
      demurrageFee: result.demurrageFee,
      demurrageLabel: result.demurrageLabel,
      currency: result.currency,
      terminal: result.terminal,
      lines,
      status: 'confirmed',
      bookedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/a1e178ae/book',
      errorClass: error.name,
      source: 'ldc-brazil-trade-desk',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/a1e178ae/book',
      error: 'true',
    });

    logger.error('LDC Brazil export contract booking failed', {
      tradeId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      trader: tradeData.trader,
      service: 'ldc-brazil-trade',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/a1e178ae/book',
        service: 'ldc-brazil-trade',
        source: 'ldc-brazil-trade-desk',
      },
      extra: {
        tradeId,
        trader: tradeData.trader,
        volumeMt: tradeData.volumeMt,
        terminal: tradeData.terminal,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/a1e178ae.js \u2014 formatContractLines',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: tradeData.devinUserId,
      devinEmail: tradeData.devinEmail,
      devinOrgId: tradeData.devinOrgId,
      service: 'ldc-brazil-trade',
      verticalLabel: 'Louis Dreyfus Company Brazil',
      customer: 'a1e178ae',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/a1e178ae/book' },
        { key: 'service', value: 'ldc-brazil-trade' },
      ],
      extra: { tradeId, trader: tradeData.trader, volumeMt: tradeData.volumeMt },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'ldc-brazil-trade@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from LDC Brazil trade error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { bookTrade, priceContract, formatContractLines, applyContractLines, COMMODITIES, EXPORT_TERMINALS };
