/**
 * Reference data behind the Capital IQ Market Monitor Global Indices widget:
 * the indices the widget lists (INDICES) and the exchange listing each index
 * detail is built from (LISTINGS, keyed by ticker).
 */
const INDICES = [
  { ticker: '^DJI', name: 'Dow Jones Industrial Average', region: 'Americas' },
  { ticker: '^GSPTSE', name: 'S&P TSX Composite Price Return', region: 'Americas' },
  { ticker: '^SPX', name: 'S&P 500 Price Return', region: 'Americas' },
  { ticker: '^MID', name: 'S&P 400 Mid Cap Price Return', region: 'Americas' },
  { ticker: '^SML', name: 'S&P 600 Small Cap Price Return', region: 'Americas' },
  { ticker: 'I:NDX', name: 'NASDAQ-100 Index Price Return', region: 'Americas' },
  { ticker: '^IBOV', name: 'Brazil IBOVESPA Index Price Return', region: 'Americas' },
  { ticker: '^DAX', name: 'Germany DAX Index (Performance)', region: 'Europe' },
  { ticker: '^DAXK', name: 'Germany DAX Index (Kursindex)', region: 'Europe' },
  { ticker: '^IBEX', name: 'IBEX 35 Price Return', region: 'Europe' },
  { ticker: '^PX1', name: 'CAC 40 Price Return', region: 'Europe' },
  { ticker: '^SXXP', name: 'STOXX Europe 600 Price Return', region: 'Europe' },
  { ticker: '^000001', name: 'China Shanghai SE Composite', region: 'Asia' },
  { ticker: '^399106', name: 'China Shenzhen Composite', region: 'Asia' },
  { ticker: '^HSCEI', name: 'Hang Seng China Enterprises', region: 'Asia' },
  { ticker: '^HSI', name: 'Hang Seng Index Price Return', region: 'Asia' },
  { ticker: '^KOSPI1', name: 'KOSPI 100 Index Price', region: 'Asia' },
  { ticker: '^KS200', name: 'KOSPI 200 Index Price Return', region: 'Asia' },
  { ticker: '^N225', name: 'Nikkei 225 Stock Average', region: 'Asia' },
  { ticker: '^NIFTY50', name: 'Nifty 50 Index Price Return', region: 'Asia' },
];

function listing(exchange, timezone, currency, constituents, provider) {
  return { exchange, timezone, currency, constituents, provider };
}

// Americas listings are synced nightly from the Refinitiv reference feed.
const AMERICAS = {
  '.DJI': listing('NYSE', 'America/New_York', 'USD', 30, 'S&P Dow Jones Indices'),
  '.GSPTSE': listing('TSX', 'America/Toronto', 'CAD', 225, 'S&P Dow Jones Indices'),
  '.SPX': listing('NYSE', 'America/New_York', 'USD', 503, 'S&P Dow Jones Indices'),
  '.MID': listing('NYSE', 'America/New_York', 'USD', 400, 'S&P Dow Jones Indices'),
  '.SML': listing('NYSE', 'America/New_York', 'USD', 600, 'S&P Dow Jones Indices'),
  '.NDX': listing('NASDAQ', 'America/New_York', 'USD', 101, 'Nasdaq'),
  '.BVSP': listing('B3', 'America/Sao_Paulo', 'BRL', 86, 'B3'),
};

const EUROPE = {
  '^DAX': listing('XETRA', 'Europe/Berlin', 'EUR', 40, 'Qontigo'),
  '^DAXK': listing('XETRA', 'Europe/Berlin', 'EUR', 40, 'Qontigo'),
  '^IBEX': listing('BME', 'Europe/Madrid', 'EUR', 35, 'BME'),
  '^PX1': listing('Euronext Paris', 'Europe/Paris', 'EUR', 40, 'Euronext'),
  '^SXXP': listing('STOXX', 'Europe/Zurich', 'EUR', 600, 'Qontigo'),
};

const ASIA = {
  '^000001': listing('SSE', 'Asia/Shanghai', 'CNY', 2263, 'SSE'),
  '^399106': listing('SZSE', 'Asia/Shanghai', 'CNY', 2826, 'SZSE'),
  '^HSCEI': listing('HKEX', 'Asia/Hong_Kong', 'HKD', 50, 'Hang Seng Indexes'),
  '^HSI': listing('HKEX', 'Asia/Hong_Kong', 'HKD', 82, 'Hang Seng Indexes'),
  '^KOSPI1': listing('KRX', 'Asia/Seoul', 'KRW', 100, 'KRX'),
  '^KS200': listing('KRX', 'Asia/Seoul', 'KRW', 200, 'KRX'),
  '^N225': listing('TSE', 'Asia/Tokyo', 'JPY', 225, 'Nikkei Inc.'),
  '^NIFTY50': listing('NSE', 'Asia/Kolkata', 'INR', 50, 'NSE Indices'),
};

const LISTINGS = { ...AMERICAS, ...EUROPE, ...ASIA };

module.exports = { INDICES, LISTINGS };
