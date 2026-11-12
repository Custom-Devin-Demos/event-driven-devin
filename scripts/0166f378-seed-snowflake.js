#!/usr/bin/env node
/**
 * Seeds the Fidelity Portfolio Summary demo schema in Snowflake.
 *
 *   node scripts/0166f378-seed-snowflake.js [--symbols 1500] [--years 10]
 *
 * Creates <SNOWFLAKE_DATABASE>.<SNOWFLAKE_SCHEMA> (default HEPPNER_DEMO.BROKERAGE).{ACCOUNTS, POSITIONS, PRICE_HISTORY}. PRICE_HISTORY
 * is a daily close series (symbols x years x 366 days, inserted in date order so
 * Snowflake micro-partitions are naturally clustered by PRICE_DATE). Requires the
 * SNOWFLAKE_* environment variables documented in app/services/snowflake-client.js.
 */
const { executeStatement, isConfigured } = require('../app/services/snowflake-client');
const {
  DATABASE, SCHEMA, PORTFOLIO, referencePrice,
} = require('../app/services/verticals/0166f378-portfolio');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}

async function run(sql) {
  process.stdout.write(`${sql.split('\n')[0].slice(0, 90)} ... `);
  const result = await executeStatement(sql, { timeoutSeconds: 600 });
  process.stdout.write(`${result.durationMs}ms\n`);
  return result;
}

async function main() {
  if (!isConfigured()) throw new Error('SNOWFLAKE_* environment variables are not set');
  const symbols = arg('symbols', 1500);
  const years = arg('years', 10);
  const fq = `${DATABASE}.${SCHEMA}`;
  const tickers = [...new Set(PORTFOLIO.positions.map((p) => p.symbol))];
  const tickerArray = tickers.map((t) => `'${t}'`).join(',');
  const priceArray = tickers.map((t) => referencePrice(t)).join(',');

  await run(`CREATE SCHEMA IF NOT EXISTS ${fq}`);

  await run(`CREATE OR REPLACE TABLE ${fq}.ACCOUNTS (
    ACCOUNT_ID VARCHAR, ACCOUNT_NAME VARCHAR, ACCOUNT_TYPE VARCHAR, CASH_BALANCE NUMBER(14,2), OWNER_ID VARCHAR)`);
  await run(`INSERT INTO ${fq}.ACCOUNTS VALUES ${PORTFOLIO.accounts
    .map((a) => `('${a.accountId}','${a.name}','${a.type}',${a.cash},'${PORTFOLIO.ownerId}')`).join(',')}`);

  await run(`CREATE OR REPLACE TABLE ${fq}.POSITIONS (
    POSITION_ID VARCHAR, ACCOUNT_ID VARCHAR, SYMBOL VARCHAR, DESCRIPTION VARCHAR, ASSET_CLASS VARCHAR,
    QUANTITY NUMBER(18,4), COST_BASIS NUMBER(14,2), OWNER_ID VARCHAR)`);
  await run(`INSERT INTO ${fq}.POSITIONS VALUES ${PORTFOLIO.positions
    .map((p, i) => `('POS-${String(i + 1).padStart(4, '0')}','${p.accountId}','${p.symbol}','${p.description.replace(/'/g, "''")}','${p.assetClass}',${p.quantity},${p.costBasis},'${PORTFOLIO.ownerId}')`).join(',')}`);

  const days = years * 366;
  await run(`CREATE OR REPLACE TABLE ${fq}.PRICE_HISTORY AS
    WITH gen AS (
      SELECT SEQ4() AS n,
             MOD(SEQ4(), ${symbols}) AS symbol_id,
             FLOOR(SEQ4() / ${symbols}) AS day_offset
      FROM TABLE(GENERATOR(ROWCOUNT => ${symbols * days}))
    ), named AS (
      SELECT *,
             ARRAY_CONSTRUCT(${tickerArray}) AS tickers,
             DATEADD(day, day_offset - ${days}, CURRENT_DATE()) AS price_date
      FROM gen
    )
    SELECT
      IFF(symbol_id < ARRAY_SIZE(tickers), tickers[symbol_id]::VARCHAR, 'SYM' || LPAD(symbol_id, 4, '0')) AS SYMBOL,
      price_date AS PRICE_DATE,
      ROUND(base_price * drift * (1 + (UNIFORM(-100, 100, RANDOM(42)) / 10000.0)), 2) AS CLOSE_PRICE,
      ROUND(base_price * drift * (1 + (UNIFORM(-120, 120, RANDOM(7)) / 10000.0)), 2) AS PREV_CLOSE,
      UNIFORM(100000, 90000000, RANDOM(3)) AS VOLUME,
      CURRENT_TIMESTAMP() AS LOADED_AT
    FROM (
      SELECT *,
             (1 + 0.35 * SIN(day_offset / 97.0 + MOD(symbol_id, 7)) + 0.00025 * day_offset) AS drift,
             (1 + 0.35 * SIN((${days} - 1) / 97.0 + MOD(symbol_id, 7)) + 0.00025 * (${days} - 1)) AS drift_today,
             ARRAY_CONSTRUCT(${priceArray}) AS targets,
             IFF(symbol_id < ARRAY_SIZE(tickers),
                 targets[symbol_id]::FLOAT / (1 + 0.35 * SIN((${days} - 1) / 97.0 + MOD(symbol_id, 7)) + 0.00025 * (${days} - 1)),
                 20 + MOD(ABS(HASH(symbol_id)), 480)) AS base_price
      FROM named
    ) priced
    WHERE DAYOFWEEKISO(price_date) <= 5
    ORDER BY price_date, SYMBOL`);

  const count = await run(`SELECT COUNT(*) AS N, MIN(PRICE_DATE) AS FIRST_DAY, MAX(PRICE_DATE) AS LAST_DAY FROM ${fq}.PRICE_HISTORY`);
  process.stdout.write(`${JSON.stringify(count.rows[0])}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
