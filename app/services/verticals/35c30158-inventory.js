/**
 * Rental inventory sources for the guest booking widget (35c30158).
 *
 * Each resort's rental shops report stock through whichever inventory
 * system that resort runs. The clients below stand in for those systems and
 * return the payload each one emits for a location.
 */

const RESORTS = [
  { id: 'vail', name: 'Vail', region: 'Colorado', deliveryOffered: true },
  { id: 'beaver-creek', name: 'Beaver Creek', region: 'Colorado', deliveryOffered: true },
  { id: 'breckenridge', name: 'Breckenridge', region: 'Colorado', deliveryOffered: true },
  { id: 'keystone', name: 'Keystone', region: 'Colorado', deliveryOffered: true },
  { id: 'park-city', name: 'Park City', region: 'Utah', deliveryOffered: true },
  { id: 'heavenly', name: 'Heavenly', region: 'California', deliveryOffered: false },
  { id: 'northstar', name: 'Northstar', region: 'California', deliveryOffered: true },
  { id: 'whistler-blackcomb', name: 'Whistler Blackcomb', region: 'Canada', deliveryOffered: false },
  { id: 'stowe', name: 'Stowe', region: 'Northeast', deliveryOffered: false },
];

/**
 * Which inventory system each resort reports through, and the contract
 * revision that location is currently on.
 */
const RESORT_INVENTORY_SOURCES = {
  vail: { system: 'alpine-fleet', contract: '2026.1', locationCode: 'VL-LIONSHEAD' },
  'beaver-creek': { system: 'alpine-fleet', contract: '2026.1', locationCode: 'BC-VILLAGE' },
  'park-city': { system: 'alpine-fleet', contract: '2024.2', locationCode: 'PC-CANYONS' },
  breckenridge: { system: 'summit-pos', contract: '9.4', locationCode: '1180' },
  keystone: { system: 'summit-pos', contract: '9.4', locationCode: '1204' },
  heavenly: { system: 'summit-pos', contract: '9.2', locationCode: '2310' },
  northstar: { system: 'summit-pos', contract: '9.2', locationCode: '2355' },
  stowe: { system: 'summit-pos', contract: '9.4', locationCode: '4020' },
  'whistler-blackcomb': { system: 'gear-hub', contract: '3', locationCode: 'WB-CREEKSIDE' },
};

const SUMMIT_POS_SKUS = [
  { code: 'SKI-SPORT', desc: 'Sport Ski Package', cat: 'SKI', lvl: 'BEG', qty_on_hand: 64, rate_cents: 5900 },
  { code: 'SKI-PERF', desc: 'Performance Ski Package', cat: 'SKI', lvl: 'INT', qty_on_hand: 38, rate_cents: 7900 },
  { code: 'SKI-DEMO', desc: 'Demo Ski Package', cat: 'SKI', lvl: 'ADV', qty_on_hand: 17, rate_cents: 9900 },
  { code: 'SKI-KIDS', desc: 'Kids Ski Package', cat: 'SKI', lvl: 'KID', qty_on_hand: 52, rate_cents: 3900 },
  { code: 'SNB-SPORT', desc: 'Sport Snowboard Package', cat: 'SNB', lvl: 'BEG', qty_on_hand: 41, rate_cents: 5900 },
  { code: 'SNB-DEMO', desc: 'Demo Snowboard Package', cat: 'SNB', lvl: 'ADV', qty_on_hand: 12, rate_cents: 9900 },
  { code: 'SNB-KIDS', desc: 'Kids Snowboard Package', cat: 'SNB', lvl: 'KID', qty_on_hand: 26, rate_cents: 3900 },
  { code: 'BIKE-TRAIL', desc: 'Trail Bike', cat: 'BIKE', lvl: 'ALL', qty_on_hand: 0, rate_cents: 8900 },
];

const ALPINE_FLEET_ITEMS = [
  { sku: 'AF-SKI-SPORT', name: 'Sport Ski Package', category: 'ski', tier: 'sport', available: 71, dailyRate: 59 },
  { sku: 'AF-SKI-PERF', name: 'Performance Ski Package', category: 'ski', tier: 'performance', available: 44, dailyRate: 79 },
  { sku: 'AF-SKI-DEMO', name: 'Demo Ski Package', category: 'ski', tier: 'demo', available: 23, dailyRate: 99 },
  { sku: 'AF-SKI-KIDS', name: 'Kids Ski Package', category: 'ski', tier: 'kids', available: 58, dailyRate: 39 },
  { sku: 'AF-SNB-SPORT', name: 'Sport Snowboard Package', category: 'snowboard', tier: 'sport', available: 36, dailyRate: 59 },
  { sku: 'AF-SNB-DEMO', name: 'Demo Snowboard Package', category: 'snowboard', tier: 'demo', available: 14, dailyRate: 99 },
  { sku: 'AF-SNB-KIDS', name: 'Kids Snowboard Package', category: 'snowboard', tier: 'kids', available: 31, dailyRate: 39 },
];

const GEAR_HUB_INVENTORY = {
  'GH-SKI-SPORT': { label: 'Sport Ski Package', group: 'ski', level: 'beginner', count: 48, price: { amount: 79, currency: 'CAD' } },
  'GH-SKI-PERF': { label: 'Performance Ski Package', group: 'ski', level: 'intermediate', count: 29, price: { amount: 105, currency: 'CAD' } },
  'GH-SKI-DEMO': { label: 'Demo Ski Package', group: 'ski', level: 'advanced', count: 11, price: { amount: 132, currency: 'CAD' } },
  'GH-SKI-KIDS': { label: 'Kids Ski Package', group: 'ski', level: 'kids', count: 40, price: { amount: 52, currency: 'CAD' } },
  'GH-SNB-SPORT': { label: 'Sport Snowboard Package', group: 'snowboard', level: 'beginner', count: 27, price: { amount: 79, currency: 'CAD' } },
  'GH-SNB-DEMO': { label: 'Demo Snowboard Package', group: 'snowboard', level: 'advanced', count: 9, price: { amount: 132, currency: 'CAD' } },
  'GH-SNB-KIDS': { label: 'Kids Snowboard Package', group: 'snowboard', level: 'kids', count: 22, price: { amount: 52, currency: 'CAD' } },
};

function summitPosClient(source) {
  return {
    store_id: source.locationCode,
    as_of: new Date().toISOString(),
    skus: SUMMIT_POS_SKUS.map((sku) => ({ ...sku })),
  };
}

function alpineFleetClient(source) {
  const generatedAt = new Date().toISOString();

  if (source.contract === '2026.1') {
    const byCategory = { ski: [], snowboard: [] };
    for (const item of ALPINE_FLEET_ITEMS) {
      byCategory[item.category].push({
        sku: item.sku,
        name: item.name,
        tier: item.tier,
        availability: { units: item.available, onHold: Math.round(item.available * 0.1) },
        pricing: { daily: item.dailyRate, currency: 'USD' },
      });
    }
    return {
      location: source.locationCode,
      generatedAt,
      fleet: byCategory,
      holds: [],
    };
  }

  return {
    location: source.locationCode,
    generatedAt,
    items: ALPINE_FLEET_ITEMS.map((item) => ({ ...item })),
  };
}

function gearHubClient(source) {
  return {
    hub: source.locationCode,
    snapshot: Date.now(),
    inventory: JSON.parse(JSON.stringify(GEAR_HUB_INVENTORY)),
  };
}

const INVENTORY_CLIENTS = {
  'summit-pos': summitPosClient,
  'alpine-fleet': alpineFleetClient,
  'gear-hub': gearHubClient,
};

/**
 * Pull the current stock report for a resort from its inventory system.
 */
async function fetchResortInventory(resortId) {
  const source = RESORT_INVENTORY_SOURCES[resortId];
  await new Promise((resolve) => { setTimeout(resolve, 40 + Math.random() * 90); });
  return {
    source,
    payload: INVENTORY_CLIENTS[source.system](source),
  };
}

module.exports = {
  RESORTS,
  RESORT_INVENTORY_SOURCES,
  fetchResortInventory,
};
