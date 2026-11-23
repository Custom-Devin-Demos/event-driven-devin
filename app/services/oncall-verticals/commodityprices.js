const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/commodityprices/assessments';
const SERVICE = 'commodity-prices-api';

const LATENCY_BUDGET_MS = 2000;
const PRICE_STORE_READ_MS = 540;
const PRICE_STORE_BATCH_MS = 260;
const HISTORY_DAYS = 5;
const ASSESSED_ON = '2026-11-20';

const SECTORS = {
  'crude-oil': 'Crude Oil',
  'refined-products': 'Refined Products',
  lng: 'LNG',
  metals: 'Metals',
  agriculture: 'Agriculture',
};

/** Daily benchmark assessments per sector: last close and the prior four closes, oldest first. */
const BENCHMARKS = [
  { symbol: 'PCAAS00', name: 'Dated Brent', hub: 'North Sea', sector: 'crude-oil', unit: '$/bbl', closes: [73.12, 73.84, 74.41, 74.02, 74.66] },
  { symbol: 'PCACG00', name: 'WTI Cushing', hub: 'US Gulf Coast', sector: 'crude-oil', unit: '$/bbl', closes: [69.48, 70.05, 70.62, 70.18, 70.91] },
  { symbol: 'AAYRG00', name: 'WTI Midland', hub: 'Rotterdam', sector: 'crude-oil', unit: '$/bbl', closes: [74.02, 74.55, 75.10, 74.86, 75.38] },
  { symbol: 'PCAAT00', name: 'Dubai', hub: 'Middle East', sector: 'crude-oil', unit: '$/bbl', closes: [72.35, 72.90, 73.44, 73.11, 73.62] },
  { symbol: 'PCABS00', name: 'Oman', hub: 'Middle East', sector: 'crude-oil', unit: '$/bbl', closes: [72.51, 73.02, 73.58, 73.26, 73.80] },
  { symbol: 'AAKNL00', name: 'Murban', hub: 'Abu Dhabi', sector: 'crude-oil', unit: '$/bbl', closes: [74.20, 74.71, 75.33, 74.95, 75.47] },
  { symbol: 'AAGXF00', name: 'Johan Sverdrup', hub: 'North Sea', sector: 'crude-oil', unit: '$/bbl', closes: [72.64, 73.30, 73.92, 73.49, 74.08] },
  { symbol: 'PCADJ00', name: 'Forties', hub: 'North Sea', sector: 'crude-oil', unit: '$/bbl', closes: [72.98, 73.66, 74.25, 73.81, 74.43] },
  { symbol: 'PCADI00', name: 'Ekofisk', hub: 'North Sea', sector: 'crude-oil', unit: '$/bbl', closes: [73.40, 74.08, 74.69, 74.28, 74.90] },
  { symbol: 'AAMBR00', name: 'Mars', hub: 'US Gulf Coast', sector: 'crude-oil', unit: '$/bbl', closes: [70.11, 70.62, 71.19, 70.80, 71.44] },
  { symbol: 'PCABO00', name: 'Basrah Medium', hub: 'Iraq', sector: 'crude-oil', unit: '$/bbl', closes: [70.85, 71.37, 71.90, 71.52, 72.06] },
  { symbol: 'AAPBE00', name: 'Brent CFD (wk 1)', hub: 'North Sea', sector: 'crude-oil', unit: '$/bbl', closes: [73.05, 73.79, 74.36, 73.95, 74.59] },
  { symbol: 'AAXYO00', name: 'RBOB Gasoline', hub: 'NY Harbor', sector: 'refined-products', unit: '¢/gal', closes: [204.1, 206.3, 207.9, 206.8, 208.6] },
  { symbol: 'AAUQC00', name: 'ULSD', hub: 'NY Harbor', sector: 'refined-products', unit: '¢/gal', closes: [231.5, 233.2, 234.8, 233.9, 235.7] },
  { symbol: 'AAIDL00', name: 'Jet Fuel CIF NWE', hub: 'Northwest Europe', sector: 'refined-products', unit: '$/mt', closes: [742.25, 746.50, 751.00, 748.75, 753.25] },
  { symbol: 'PJABF00', name: 'Gasoil 0.1% FOB ARA', hub: 'ARA', sector: 'refined-products', unit: '$/mt', closes: [688.50, 692.00, 695.75, 693.25, 697.50] },
  { symbol: 'PUAFZ00', name: 'Fuel Oil 3.5% FOB Singapore', hub: 'Singapore', sector: 'refined-products', unit: '$/mt', closes: [431.20, 433.85, 436.10, 434.40, 437.05] },
  { symbol: 'AAPKA00', name: 'Naphtha CFR Japan', hub: 'Japan', sector: 'refined-products', unit: '$/mt', closes: [621.75, 625.00, 628.50, 626.25, 629.75] },
  { symbol: 'AAOVQ00', name: 'JKM', hub: 'Northeast Asia', sector: 'lng', unit: '$/MMBtu', closes: [13.42, 13.58, 13.71, 13.64, 13.82] },
  { symbol: 'AASXU00', name: 'NWE LNG DES', hub: 'Northwest Europe', sector: 'lng', unit: '$/MMBtu', closes: [12.88, 13.01, 13.15, 13.06, 13.24] },
  { symbol: 'AAVAH00', name: 'Gulf Coast LNG FOB', hub: 'US Gulf Coast', sector: 'lng', unit: '$/MMBtu', closes: [10.12, 10.25, 10.37, 10.30, 10.46] },
  { symbol: 'MMAAL00', name: 'Aluminium P1020 CIF Rotterdam', hub: 'Rotterdam', sector: 'metals', unit: '$/mt', closes: [2614, 2628, 2641, 2633, 2652] },
  { symbol: 'MMCUC00', name: 'Copper Cathode CIF China', hub: 'China', sector: 'metals', unit: '$/mt', closes: [9412, 9455, 9498, 9470, 9521] },
  { symbol: 'IODBZ00', name: 'Iron Ore 62% Fe CFR China', hub: 'China', sector: 'metals', unit: '$/dmt', closes: [104.35, 105.10, 105.80, 105.25, 106.05] },
  { symbol: 'MMLIC00', name: 'Lithium Carbonate CIF NE Asia', hub: 'Northeast Asia', sector: 'metals', unit: '$/kg', closes: [10.15, 10.20, 10.32, 10.27, 10.40] },
  { symbol: 'AGWHB00', name: 'Wheat 12.5% FOB Black Sea', hub: 'Black Sea', sector: 'agriculture', unit: '$/mt', closes: [228.50, 229.75, 231.00, 230.25, 232.00] },
  { symbol: 'AGCRB00', name: 'Corn FOB Santos', hub: 'Brazil', sector: 'agriculture', unit: '$/mt', closes: [206.25, 207.00, 208.50, 207.75, 209.25] },
  { symbol: 'AGSBB00', name: 'Soybeans FOB Paranaguá', hub: 'Brazil', sector: 'agriculture', unit: '$/mt', closes: [418.75, 420.50, 422.25, 421.00, 423.50] },
  { symbol: 'AGSUW00', name: 'White Sugar FOB Santos', hub: 'Brazil', sector: 'agriculture', unit: '$/mt', closes: [512.40, 514.10, 516.85, 515.20, 518.05] },
];

class CommodityLatencyBudgetExceeded extends Error {
  constructor(durationMs, sector, symbols) {
    super(`Commodity assessments for ${sector} took ${durationMs}ms (budget ${LATENCY_BUDGET_MS}ms, ${symbols} symbols)`);
    this.name = 'CommodityLatencyBudgetExceeded';
  }
}

function historyFor(benchmark) {
  return benchmark.closes.slice(-HISTORY_DAYS).map((close, i, all) => ({
    date: new Date(Date.parse(`${ASSESSED_ON}T00:00:00Z`) - (all.length - 1 - i) * 86400000).toISOString().slice(0, 10),
    close,
  }));
}

/** Price-store read of one symbol's recent assessment history. */
function readAssessmentHistory(symbol) {
  const benchmark = BENCHMARKS.find((b) => b.symbol === symbol);
  return new Promise((resolve) => {
    setTimeout(() => resolve({ symbol, history: historyFor(benchmark) }), PRICE_STORE_READ_MS);
  });
}

/** Price-store read of several symbols' recent assessment histories in one round trip. */
function readAssessmentHistories(symbols) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(symbols.map((symbol) => ({
      symbol, history: historyFor(BENCHMARKS.find((b) => b.symbol === symbol)),
    }))), PRICE_STORE_BATCH_MS);
  });
}

async function loadHistories(symbols) {
  const histories = [];
  for (const symbol of symbols) {
    histories.push(await readAssessmentHistory(symbol));
  }
  return histories;
}

function toRow(benchmark, history) {
  const last = history[history.length - 1].close;
  const prior = history[history.length - 2].close;
  const change = Math.round((last - prior) * 100) / 100;
  return {
    symbol: benchmark.symbol,
    name: benchmark.name,
    hub: benchmark.hub,
    unit: benchmark.unit,
    close: last,
    change,
    changePct: Math.round((change / prior) * 10000) / 100,
    history,
  };
}

function normalizeSector(value) {
  const key = String(value || '').trim().toLowerCase() || 'crude-oil';
  if (!Object.hasOwn(SECTORS, key)) {
    const error = new Error(`Unknown sector: ${key}`);
    error.code = 'INVALID_SECTOR';
    throw error;
  }
  return key;
}

/**
 * Load the latest daily benchmark assessments for one sector with their
 * recent history for the price grid.
 */
async function loadAssessments(request, options = {}) {
  const startTime = Date.now();
  const requestId = `asm_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  let sector = null;

  try {
    sector = normalizeSector(request && request.sector);
    const benchmarks = BENCHMARKS.filter((b) => b.sector === sector);
    logger.info('Commodity assessments request', {
      requestId, sector, symbols: benchmarks.length, service: SERVICE, route: ROUTE,
    });

    const histories = await loadHistories(benchmarks.map((b) => b.symbol));
    const bySymbol = new Map(histories.map((h) => [h.symbol, h.history]));
    const assessments = benchmarks.map((b) => toRow(b, bySymbol.get(b.symbol)));
    const duration = Date.now() - startTime;

    incrementMetric('commodityprices.assessments.success', { route: ROUTE, sector });
    recordTiming('commodityprices.assessments.latency', duration, { route: ROUTE, sector });
    logger.info('Commodity assessments completed', { requestId, sector, durationMs: duration, symbols: benchmarks.length });

    if (duration > LATENCY_BUDGET_MS) {
      logger.warn('Commodity assessments exceeded latency budget', {
        requestId, sector, durationMs: duration, budgetMs: LATENCY_BUDGET_MS, symbols: benchmarks.length, service: SERVICE, route: ROUTE,
      });
      Sentry.captureException(new CommodityLatencyBudgetExceeded(duration, sector, benchmarks.length), {
        level: 'warning',
        tags: { route: ROUTE, service: SERVICE, sector, ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { requestId, durationMs: duration, budgetMs: LATENCY_BUDGET_MS, symbols: benchmarks.length },
      });
    }

    return {
      success: true,
      requestId,
      sector: SECTORS[sector],
      assessedOn: ASSESSED_ON,
      assessments,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('commodityprices.assessments.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('commodityprices.assessments.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Commodity assessments failed', {
      requestId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, sector,
    });
    if (error.code !== 'INVALID_SECTOR') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { requestId, sector },
      });
    }
    throw error;
  }
}

module.exports = {
  loadAssessments,
  readAssessmentHistories,
  BENCHMARKS,
  SECTORS,
  LATENCY_BUDGET_MS,
  PRICE_STORE_READ_MS,
};
