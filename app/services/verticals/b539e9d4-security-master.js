const SECURITIES = {
  KSTL: {
    symbol: 'KSTL',
    name: 'Kestrel Aerospace Holdings Inc.',
    shareClass: 'A',
    cusip: '48800A101',
    isin: 'US48800A1016',
    exchange: 'NYSE',
    sector: 'Industrials',
    sharesOutstanding: 38900000,
    iwf: 0.14,
    lastClose: 141.95,
  },
  'KSTL/B': {
    symbol: 'KSTL/B',
    name: 'Kestrel Aerospace Holdings Inc.',
    shareClass: 'B',
    cusip: '48800A200',
    isin: 'US48800A2006',
    exchange: 'NYSE',
    sector: 'Industrials',
    sharesOutstanding: 312400000,
    iwf: 0.96,
    lastClose: 142.18,
  },
  HLVR: {
    symbol: 'HLVR',
    name: 'Halvorsen Retail Group Inc.',
    shareClass: null,
    cusip: '40622R104',
    isin: 'US40622R1041',
    exchange: 'NYSE',
    sector: 'Consumer Discretionary',
    sharesOutstanding: 118600000,
    iwf: 0.99,
    lastClose: 61.42,
  },
  PNCL: {
    symbol: 'PNCL',
    name: 'Pinecrest Laboratories Inc.',
    shareClass: null,
    cusip: '72300K105',
    isin: 'US72300K1051',
    exchange: 'NASDAQ',
    sector: 'Health Care',
    sharesOutstanding: 54200000,
    iwf: 0.91,
    lastClose: 38.07,
  },
  BWTR: {
    symbol: 'BWTR',
    name: 'Brightwater Bancorp',
    shareClass: null,
    cusip: '10921B106',
    isin: 'US10921B1061',
    exchange: 'NYSE',
    sector: 'Financials',
    sharesOutstanding: 96300000,
    iwf: 1,
    lastClose: 47.6,
  },
  OLF: {
    symbol: 'OLF',
    name: 'Orchard Lane Foods Co.',
    shareClass: null,
    cusip: '68555L103',
    isin: 'US68555L1035',
    exchange: 'NYSE',
    sector: 'Consumer Staples',
    sharesOutstanding: 41800000,
    iwf: 0.88,
    lastClose: 22.14,
  },
  'BRK/B': {
    symbol: 'BRK/B',
    name: 'Berkshire Hathaway Inc.',
    shareClass: 'B',
    cusip: '084670702',
    isin: 'US0846707026',
    exchange: 'NYSE',
    sector: 'Financials',
    sharesOutstanding: 1318000000,
    iwf: 0.88,
    lastClose: 468.31,
  },
};

// Strip vendor venue suffixes from announcement tickers (PNCL.OQ -> PNCL).
function normalizeTicker(raw) {
  return String(raw || '').trim().toUpperCase().split('.')[0];
}

function resolveSecurity(ticker) {
  const symbol = normalizeTicker(ticker);
  const record = SECURITIES[symbol];
  if (!record) {
    const error = new Error(`No security master record for ${ticker} (normalized ${symbol})`);
    error.name = 'SecurityNotFoundError';
    throw error;
  }
  return { ...record, requestedTicker: ticker };
}

module.exports = { SECURITIES, normalizeTicker, resolveSecurity };
