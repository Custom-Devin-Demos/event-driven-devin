/**
 * Static reference data for the Fidelity Portfolio Summary demo (customer 0166f378).
 * The same records are seeded into Snowflake by scripts/0166f378-seed-snowflake.js
 * and used by the embedded Snowflake emulator when SNOWFLAKE_* is not configured.
 */
const DATABASE = (process.env.SNOWFLAKE_DATABASE || 'HEPPNER_DEMO').trim();
const SCHEMA = (process.env.SNOWFLAKE_SCHEMA || 'BROKERAGE').trim();

const PORTFOLIO = {
  ownerId: 'CUST-8841027',
  owner: { name: 'Jordan Ellis', lastLogin: 'Today 8:42 AM ET' },
  accounts: [
    { accountId: 'Z23-418902', name: 'Individual - TOD', type: 'Brokerage', cash: 18420.17 },
    { accountId: '238-551204', name: 'Roth IRA', type: 'Retirement', cash: 2210.55 },
    { accountId: '77631', name: 'Northwind Tech 401(k)', type: 'Workplace', cash: 0 },
    { accountId: 'X09-115873', name: 'Cash Management', type: 'Spending', cash: 6102.90 },
  ],
  positions: [
    { accountId: 'Z23-418902', symbol: 'AAPL', description: 'APPLE INC', assetClass: 'Stock', price: 268.5, quantity: 140, costBasis: 18940.00 },
    { accountId: 'Z23-418902', symbol: 'MSFT', description: 'MICROSOFT CORP', assetClass: 'Stock', price: 508.2, quantity: 85, costBasis: 24310.00 },
    { accountId: 'Z23-418902', symbol: 'NVDA', description: 'NVIDIA CORP', assetClass: 'Stock', price: 186.4, quantity: 60, costBasis: 9120.00 },
    { accountId: 'Z23-418902', symbol: 'AMZN', description: 'AMAZON.COM INC', assetClass: 'Stock', price: 244.3, quantity: 48, costBasis: 7210.00 },
    { accountId: 'Z23-418902', symbol: 'FXAIX', description: 'FIDELITY 500 INDEX FUND', assetClass: 'Mutual Fund', price: 232.1, quantity: 312.418, costBasis: 51230.00 },
    { accountId: 'Z23-418902', symbol: 'FBTC', description: 'FIDELITY WISE ORIGIN BITCOIN FUND', assetClass: 'ETF', price: 88.6, quantity: 90, costBasis: 5580.00 },
    { accountId: 'Z23-418902', symbol: 'FDRXX', description: 'FIDELITY GOVERNMENT CASH RESERVES', assetClass: 'Money Market', price: 1, quantity: 18420.17, costBasis: 18420.17 },
    { accountId: '238-551204', symbol: 'FSKAX', description: 'FIDELITY TOTAL MARKET INDEX FUND', assetClass: 'Mutual Fund', price: 182.4, quantity: 410.902, costBasis: 60110.00 },
    { accountId: '238-551204', symbol: 'FTIHX', description: 'FIDELITY TOTAL INTERNATIONAL INDEX FUND', assetClass: 'Mutual Fund', price: 17.9, quantity: 1210.33, costBasis: 17880.00 },
    { accountId: '238-551204', symbol: 'FXNAX', description: 'FIDELITY US BOND INDEX FUND', assetClass: 'Mutual Fund', price: 10.6, quantity: 820.11, costBasis: 9650.00 },
    { accountId: '238-551204', symbol: 'VOO', description: 'VANGUARD S&P 500 ETF', assetClass: 'ETF', price: 620.3, quantity: 26, costBasis: 10980.00 },
    { accountId: '77631', symbol: 'FFFHX', description: 'FIDELITY FREEDOM 2050 FUND', assetClass: 'Mutual Fund', price: 19.4, quantity: 2640.772, costBasis: 41900.00 },
    { accountId: '77631', symbol: 'FSMDX', description: 'FIDELITY MID CAP INDEX FUND', assetClass: 'Mutual Fund', price: 36.2, quantity: 418.5, costBasis: 12640.00 },
    { accountId: '77631', symbol: 'FSSNX', description: 'FIDELITY SMALL CAP INDEX FUND', assetClass: 'Mutual Fund', price: 31.7, quantity: 505.02, costBasis: 13110.00 },
    { accountId: 'X09-115873', symbol: 'SPAXX', description: 'FIDELITY GOVERNMENT MONEY MARKET', assetClass: 'Money Market', price: 1, quantity: 6102.90, costBasis: 6102.90 },
    { accountId: 'Z23-418902', symbol: 'GOOGL', description: 'ALPHABET INC CL A', assetClass: 'Stock', price: 282.7, quantity: 55, costBasis: 7415.00 },
    { accountId: 'Z23-418902', symbol: 'JPM', description: 'JPMORGAN CHASE & CO', assetClass: 'Stock', price: 311.5, quantity: 40, costBasis: 6120.00 },
    { accountId: 'Z23-418902', symbol: 'XOM', description: 'EXXON MOBIL CORP', assetClass: 'Stock', price: 118.9, quantity: 70, costBasis: 7140.00 },
  ],
};

/** Reference close for a ticker (today's price target used by the seed and the emulator). */
function referencePrice(symbol) {
  const position = PORTFOLIO.positions.find((p) => p.symbol === symbol);
  return position ? position.price : null;
}

module.exports = {
  DATABASE, SCHEMA, PORTFOLIO, referencePrice,
};
