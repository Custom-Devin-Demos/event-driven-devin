/**
 * Embedded Snowflake emulator for the Fidelity Portfolio Summary demo (customer 0166f378).
 *
 * Used when SNOWFLAKE_* credentials are not configured (local dev, CI, the demo host
 * without a Snowflake secret). It serves the same PRICE_HISTORY/POSITIONS schema as
 * scripts/0166f378-seed-snowflake.js and models the warehouse's cost for the statement
 * it is given, so a query with no pruning predicate on PRICE_DATE is slow here for the
 * same reason it is slow in Snowflake: it scans every micro-partition and ships every
 * historical row to the app.
 */
const { PORTFOLIO, referencePrice } = require('./0166f378-portfolio');

const SYMBOL_COUNT = 1500;
const HISTORY_YEARS = 10;
const TRADING_DAYS_PER_YEAR = 261;
const ROWS_PER_MICRO_PARTITION = 60000;
const BYTES_PER_ROW = 17; // compressed columnar estimate, matches the live table (~65 MB / 3.9M rows)

const COST_MODEL = {
  compileMs: 160,
  scanMsPerMillionRows: 520,
  resultMsPerThousandRows: 58, // REST result-set partitions streamed to the app
  sortMsPerThousandRows: 4,
};

const DAY_MS = 86400000;
const WAIT = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tradingDaysBetween(from, to) {
  let count = 0;
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

function latestTradingDay(asOf) {
  const d = new Date(asOf);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

const FIRST_EPOCH_DAY = 17109;

function drift(symbol, dayOffset) {
  return 1 + 0.35 * Math.sin(dayOffset / 97 + (hash(symbol) % 7)) + 0.00025 * dayOffset;
}

function closeFor(symbol, date) {
  const dayOffset = Math.floor(date.getTime() / DAY_MS) - FIRST_EPOCH_DAY;
  const todayOffset = Math.floor(Date.now() / DAY_MS) - FIRST_EPOCH_DAY;
  const target = referencePrice(symbol);
  const base = target ? target / drift(symbol, todayOffset) : 20 + (hash(symbol) % 480);
  const noise = 1 + ((hash(`${symbol}:${dayOffset}`) % 201) - 100) / 10000;
  return Math.round(base * drift(symbol, dayOffset) * noise * 100) / 100;
}

function previousTradingDay(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - 1);
  return latestTradingDay(d);
}

/**
 * Inspect the statement to decide which micro-partitions Snowflake could prune and
 * whether the latest-row dedup happens in the warehouse (QUALIFY/ROW_NUMBER/MAX) or in
 * the app (every historical row shipped back).
 */
function analyseStatement(statement) {
  const sql = statement.replace(/\s+/g, ' ').toUpperCase();
  const dateColumnWrapped = /(TO_VARCHAR|TO_CHAR|CAST|DATE_TRUNC|YEAR|TO_DATE)\s*\(\s*(H\.)?PRICE_DATE/.test(sql);
  const windowFilter = /\bPRICE_DATE\s*(>=|>|BETWEEN)\s/.test(sql)
    || /PRICE_DATE\s*=\s*\(\s*SELECT\s+MAX/.test(sql)
    || /DATEADD\([^)]*\)\s*(<=|<)\s*(H\.)?PRICE_DATE/.test(sql);
  const prunable = windowFilter && !dateColumnWrapped;
  const dedupInWarehouse = /\bQUALIFY\b/.test(sql) || /ROW_NUMBER\s*\(/.test(sql) || /MAX\s*\(\s*(H\.)?PRICE_DATE/.test(sql);
  let windowDays = null;
  const dateAdd = sql.match(/DATEADD\(\s*'?(DAY|DAYS|WEEK|MONTH)'?\s*,\s*-?(\d+)/);
  if (dateAdd) {
    const [, unit, n] = dateAdd;
    windowDays = { DAY: 1, DAYS: 1, WEEK: 7, MONTH: 31 }[unit] * Number(n);
  } else if (prunable) {
    windowDays = 1;
  }
  return { prunable, dedupInWarehouse, windowDays, dateColumnWrapped };
}

async function executeStatement(statement, { bindings = {} } = {}) {
  const startedAt = Date.now();
  const ownerId = (bindings[1] || {}).value || PORTFOLIO.ownerId;
  const asOfValue = (bindings[2] || {}).value;
  const asOf = latestTradingDay(asOfValue ? new Date(`${asOfValue}T00:00:00Z`) : new Date());
  const historyStart = new Date(asOf);
  historyStart.setUTCFullYear(historyStart.getUTCFullYear() - HISTORY_YEARS);

  const totalRows = SYMBOL_COUNT * HISTORY_YEARS * TRADING_DAYS_PER_YEAR;
  const partitionsTotal = Math.ceil(totalRows / ROWS_PER_MICRO_PARTITION);
  const plan = analyseStatement(statement);

  const positions = PORTFOLIO.positions.filter(() => ownerId === PORTFOLIO.ownerId);
  let daysPerPosition;
  let partitionsScanned;
  if (plan.prunable) {
    const windowStart = new Date(asOf);
    windowStart.setUTCDate(windowStart.getUTCDate() - (plan.windowDays || 1));
    daysPerPosition = Math.max(1, tradingDaysBetween(windowStart, asOf));
    partitionsScanned = Math.max(1, Math.ceil((daysPerPosition * SYMBOL_COUNT) / ROWS_PER_MICRO_PARTITION));
  } else {
    daysPerPosition = tradingDaysBetween(historyStart, asOf);
    partitionsScanned = partitionsTotal;
  }
  const rowsScanned = partitionsScanned * ROWS_PER_MICRO_PARTITION;
  const rowsProduced = plan.dedupInWarehouse ? positions.length : positions.length * daysPerPosition;

  const modelledMs = COST_MODEL.compileMs
    + (rowsScanned / 1e6) * COST_MODEL.scanMsPerMillionRows
    + (rowsProduced / 1e3) * (COST_MODEL.resultMsPerThousandRows + COST_MODEL.sortMsPerThousandRows);
  await WAIT(modelledMs);

  const rows = [];
  positions.forEach((position, index) => {
    const positionId = `POS-${String(index + 1).padStart(4, '0')}`;
    let date = new Date(asOf);
    for (let i = 0; i < (plan.dedupInWarehouse ? 1 : daysPerPosition); i += 1) {
      rows.push({
        POSITION_ID: positionId,
        ACCOUNT_ID: position.accountId,
        SYMBOL: position.symbol,
        DESCRIPTION: position.description,
        ASSET_CLASS: position.assetClass,
        QUANTITY: position.quantity.toFixed(4),
        COST_BASIS: position.costBasis.toFixed(2),
        PRICE_DATE: String(Math.floor(date.getTime() / DAY_MS)),
        CLOSE_PRICE: closeFor(position.symbol, date).toFixed(2),
        PREV_CLOSE: closeFor(position.symbol, previousTradingDay(date)).toFixed(2),
      });
      date = previousTradingDay(date);
    }
  });

  const queryId = `emu-${hash(statement + startedAt).toString(16).padStart(8, '0')}-${startedAt.toString(36)}`;
  return {
    rows,
    queryId,
    statementHandle: queryId,
    durationMs: Date.now() - startedAt,
    profile: {
      source: 'emulator',
      warehouseSize: 'X-Small',
      partitionsScanned,
      partitionsTotal,
      bytesScanned: rowsScanned * BYTES_PER_ROW,
      rowsScanned,
      rowsProduced,
      pruned: plan.prunable,
      dedupInWarehouse: plan.dedupInWarehouse,
      executionTimeMs: Math.round(modelledMs - COST_MODEL.compileMs),
      compilationTimeMs: COST_MODEL.compileMs,
    },
  };
}

module.exports = { executeStatement, analyseStatement, COST_MODEL };
