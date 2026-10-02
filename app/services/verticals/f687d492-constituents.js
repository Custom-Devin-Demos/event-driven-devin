const INDEX_FAMILY = [
  {
    id: 'SPX',
    ticker: 'SPX',
    name: 'S&P 500',
    family: 'U.S. Equity · Headline',
    weighting: 'cap',
    constituents: 503,
    priorClose: 6715.35,
    settlementUse: 'SPX options · ES futures',
  },
  {
    id: 'OEX',
    ticker: 'OEX',
    name: 'S&P 100',
    family: 'U.S. Equity · Mega cap',
    weighting: 'cap',
    constituents: 101,
    priorClose: 3302.11,
    settlementUse: 'OEX / XEO options',
  },
  {
    id: 'MID',
    ticker: 'MID',
    name: 'S&P MidCap 400',
    family: 'U.S. Equity · Mid cap',
    weighting: 'cap',
    constituents: 401,
    priorClose: 3281.9,
    settlementUse: 'EMD futures',
  },
  {
    id: 'SML',
    ticker: 'SML',
    name: 'S&P SmallCap 600',
    family: 'U.S. Equity · Small cap',
    weighting: 'cap',
    constituents: 602,
    priorClose: 1498.62,
    settlementUse: 'SMC futures',
  },
  {
    id: 'DJI',
    ticker: 'DJI',
    name: 'Dow Jones Industrial Average',
    family: 'U.S. Equity · Price weighted',
    weighting: 'price',
    constituents: 30,
    priorClose: 46441.1,
    settlementUse: 'DJX options · YM futures',
  },
];

const MEGA_CAP_SAMPLE = [
  { ticker: 'NVDA', name: 'NVIDIA Corp', sharesMn: 24400, iwf: 0.96, priorClose: 187.12 },
  { ticker: 'AAPL', name: 'Apple Inc', sharesMn: 14840, iwf: 1.0, priorClose: 255.45 },
  { ticker: 'MSFT', name: 'Microsoft Corp', sharesMn: 7430, iwf: 1.0, priorClose: 517.95 },
  { ticker: 'AMZN', name: 'Amazon.com Inc', sharesMn: 10610, iwf: 0.9, priorClose: 219.51 },
  { ticker: 'GOOGL', name: 'Alphabet Inc Class A', sharesMn: 5820, iwf: 0.93, priorClose: 243.72 },
  { ticker: 'META', name: 'Meta Platforms Inc', sharesMn: 2180, iwf: 0.99, priorClose: 733.67 },
  { ticker: 'AVGO', name: 'Broadcom Inc', sharesMn: 4710, iwf: 1.0, priorClose: 334.56 },
  { ticker: 'BRK.B', name: 'Berkshire Hathaway Class B', sharesMn: 1310, iwf: 0.72, priorClose: 497.03 },
  { ticker: 'TSLA', name: 'Tesla Inc', sharesMn: 3210, iwf: 0.86, priorClose: 436.0 },
  { ticker: 'JPM', name: 'JPMorgan Chase & Co', sharesMn: 2760, iwf: 1.0, priorClose: 310.11 },
];

const ROSTERS = {
  SPX: MEGA_CAP_SAMPLE,
  OEX: MEGA_CAP_SAMPLE.slice(0, 8),
  MID: [
    { ticker: 'EME', name: 'EMCOR Group Inc', sharesMn: 45, iwf: 1.0, priorClose: 648.11 },
    { ticker: 'CSL', name: 'Carlisle Companies Inc', sharesMn: 44, iwf: 1.0, priorClose: 362.4 },
    { ticker: 'RS', name: 'Reliance Inc', sharesMn: 53, iwf: 1.0, priorClose: 291.07 },
    { ticker: 'WSM', name: 'Williams-Sonoma Inc', sharesMn: 122, iwf: 1.0, priorClose: 198.56 },
    { ticker: 'LII', name: 'Lennox International Inc', sharesMn: 35, iwf: 0.98, priorClose: 539.2 },
    { ticker: 'GGG', name: 'Graco Inc', sharesMn: 168, iwf: 1.0, priorClose: 84.33 },
    { ticker: 'DUOL', name: 'Duolingo Inc', sharesMn: 38, iwf: 0.88, priorClose: 312.74 },
    { ticker: 'TOL', name: 'Toll Brothers Inc', sharesMn: 98, iwf: 1.0, priorClose: 140.92 },
  ],
  SML: [
    { ticker: 'MLI', name: 'Mueller Industries Inc', sharesMn: 112, iwf: 1.0, priorClose: 98.44 },
    { ticker: 'BMI', name: 'Badger Meter Inc', sharesMn: 29, iwf: 1.0, priorClose: 214.6 },
    { ticker: 'ENSG', name: 'The Ensign Group Inc', sharesMn: 56, iwf: 0.97, priorClose: 168.21 },
    { ticker: 'AWI', name: 'Armstrong World Industries', sharesMn: 43, iwf: 1.0, priorClose: 193.08 },
    { ticker: 'ATGE', name: 'Adtalem Global Education', sharesMn: 36, iwf: 1.0, priorClose: 131.77 },
    { ticker: 'FSS', name: 'Federal Signal Corp', sharesMn: 61, iwf: 1.0, priorClose: 118.9 },
    { ticker: 'SPSC', name: 'SPS Commerce Inc', sharesMn: 37, iwf: 1.0, priorClose: 117.35 },
    { ticker: 'CALM', name: 'Cal-Maine Foods Inc', sharesMn: 44, iwf: 0.71, priorClose: 92.16 },
  ],
  DJI: [
    { ticker: 'GS', name: 'Goldman Sachs Group Inc', sharesMn: 1, iwf: 1.0, priorClose: 790.2 },
    { ticker: 'MSFT', name: 'Microsoft Corp', sharesMn: 1, iwf: 1.0, priorClose: 517.95 },
    { ticker: 'CAT', name: 'Caterpillar Inc', sharesMn: 1, iwf: 1.0, priorClose: 480.11 },
    { ticker: 'HD', name: 'Home Depot Inc', sharesMn: 1, iwf: 1.0, priorClose: 410.33 },
    { ticker: 'SHW', name: 'Sherwin-Williams Co', sharesMn: 1, iwf: 1.0, priorClose: 352.9 },
    { ticker: 'UNH', name: 'UnitedHealth Group Inc', sharesMn: 1, iwf: 1.0, priorClose: 352.8 },
    { ticker: 'V', name: 'Visa Inc Class A', sharesMn: 1, iwf: 1.0, priorClose: 345.52 },
    { ticker: 'AXP', name: 'American Express Co', sharesMn: 1, iwf: 1.0, priorClose: 332.19 },
    { ticker: 'MCD', name: "McDonald's Corp", sharesMn: 1, iwf: 1.0, priorClose: 305.5 },
    { ticker: 'AMGN', name: 'Amgen Inc', sharesMn: 1, iwf: 1.0, priorClose: 290.15 },
  ],
};

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function rosterFor(index) {
  return ROSTERS[index.id] || [];
}

function lineWeight(index, member) {
  return index.weighting === 'price' ? 1 : member.sharesMn * member.iwf;
}

function divisorFor(index) {
  const priorAggregate = rosterFor(index)
    .reduce((sum, member) => sum + member.priorClose * lineWeight(index, member), 0);
  return priorAggregate / index.priorClose;
}

function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function dailyMove(ticker, tradeDate) {
  const seed = hashSeed(`${ticker}|${tradeDate}`);
  return ((seed % 4801) / 100000) - 0.024;
}

function collectClosingPrices(index, tradeDate) {
  const quotes = {};
  rosterFor(index).forEach((member) => {
    const move = dailyMove(member.ticker, tradeDate);
    quotes[member.ticker] = {
      ticker: member.ticker,
      close: round(member.priorClose * (1 + move), 2),
      changePct: round(move * 100, 2),
      venue: 'SIP consolidated tape',
      asOf: `${tradeDate}T16:00:00-04:00`,
      status: 'official',
    };
  });
  return {
    indexId: index.id,
    tradeDate,
    source: 'CTA/UTP closing prints',
    quoteCount: Object.keys(quotes).length,
    quotes,
  };
}

module.exports = {
  INDEX_FAMILY,
  ROSTERS,
  rosterFor,
  lineWeight,
  divisorFor,
  collectClosingPrices,
  round,
};
