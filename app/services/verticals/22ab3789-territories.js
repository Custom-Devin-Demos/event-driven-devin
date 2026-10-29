/**
 * Customer 22ab3789 — enterprise sales territories.
 *
 * Each territory owns the markets (ISO 3166-1 country codes) its account teams
 * cover and the intake queues that inbound contact requests land in, keyed by
 * the topic the visitor picked.
 */
const TERRITORIES = [
  {
    id: 'NA-ENT',
    name: 'North America Enterprise',
    markets: ['us', 'ca', 'pr'],
    timezone: 'America/Denver',
    queues: {
      general: { id: 'na-ent-inbound', name: 'Enterprise Inbound', responseMinutes: 60 },
      networking: { id: 'na-ent-network', name: 'Networking & Edge Specialists', responseMinutes: 45 },
      security: { id: 'na-ent-security', name: 'Security Solutions Desk', responseMinutes: 30 },
      support: { id: 'na-ent-care', name: 'Enterprise Customer Care', responseMinutes: 15 },
    },
  },
  {
    id: 'LATAM',
    name: 'Latin America',
    markets: ['mx', 'br', 'ar', 'cl', 'co', 'pe'],
    timezone: 'America/Mexico_City',
    queues: {
      general: { id: 'latam-inbound', name: 'LATAM Inbound', responseMinutes: 120 },
      support: { id: 'latam-care', name: 'LATAM Customer Care', responseMinutes: 30 },
    },
  },
  {
    id: 'EMEA',
    name: 'Europe, Middle East & Africa',
    markets: ['gb', 'ie', 'de', 'fr', 'nl', 'es', 'ae'],
    timezone: 'Europe/London',
    queues: {
      general: { id: 'emea-inbound', name: 'EMEA Inbound', responseMinutes: 90 },
      networking: { id: 'emea-network', name: 'EMEA Network Specialists', responseMinutes: 60 },
      support: { id: 'emea-care', name: 'EMEA Customer Care', responseMinutes: 30 },
    },
  },
  {
    id: 'APAC',
    name: 'Asia Pacific',
    markets: ['sg', 'au', 'jp', 'hk', 'in'],
    timezone: 'Asia/Singapore',
    queues: {
      general: { id: 'apac-inbound', name: 'APAC Inbound', responseMinutes: 120 },
      support: { id: 'apac-care', name: 'APAC Customer Care', responseMinutes: 30 },
    },
  },
];

const TERRITORY_BY_MARKET = new Map();
for (const territory of TERRITORIES) {
  for (const market of territory.markets) TERRITORY_BY_MARKET.set(market, territory);
}

function territoryFor(market) {
  return TERRITORY_BY_MARKET.get(market);
}

function queueFor(territory, topic) {
  return territory.queues[topic] || territory.queues.general;
}

function isServedMarket(market) {
  return TERRITORY_BY_MARKET.has(String(market).toLowerCase());
}

module.exports = { TERRITORIES, territoryFor, queueFor, isServedMarket };
