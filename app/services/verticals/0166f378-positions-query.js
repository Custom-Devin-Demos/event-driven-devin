/**
 * Snowflake SQL for the Fidelity Portfolio Summary positions grid (customer 0166f378).
 *
 * The summary needs, for every position the customer owns, the latest close on or
 * before the as-of date. PRICE_HISTORY holds ~10 years of daily closes per symbol
 * and is naturally clustered by PRICE_DATE.
 */
const { DATABASE, SCHEMA } = require('./0166f378-portfolio');

const POSITIONS_TABLE = `${DATABASE}.${SCHEMA}.POSITIONS`;
const PRICE_HISTORY_TABLE = `${DATABASE}.${SCHEMA}.PRICE_HISTORY`;

/**
 * Builds the positions-with-prices statement. Bindings: 1 = owner id, 2 = as-of date (YYYY-MM-DD).
 * Rows come back ordered by position then price date descending; the service keeps
 * the first row it sees per position as the latest close.
 */
function buildPositionsQuery() {
  return [
    'SELECT p.POSITION_ID, p.ACCOUNT_ID, p.SYMBOL, p.DESCRIPTION, p.ASSET_CLASS, p.QUANTITY, p.COST_BASIS,',
    '       h.PRICE_DATE, h.CLOSE_PRICE, h.PREV_CLOSE',
    `FROM ${POSITIONS_TABLE} p`,
    `JOIN ${PRICE_HISTORY_TABLE} h ON h.SYMBOL = p.SYMBOL`,
    'WHERE p.OWNER_ID = ?',
    "  AND TO_VARCHAR(h.PRICE_DATE, 'YYYY-MM-DD') <= ?",
    'ORDER BY p.POSITION_ID, h.PRICE_DATE DESC',
  ].join('\n');
}

function positionsQueryBindings(ownerId, asOfDate) {
  return {
    1: { type: 'TEXT', value: ownerId },
    2: { type: 'TEXT', value: asOfDate },
  };
}

module.exports = {
  POSITIONS_TABLE, PRICE_HISTORY_TABLE, buildPositionsQuery, positionsQueryBindings,
};
