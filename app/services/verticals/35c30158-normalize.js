/**
 * Normalizes stock reports from the different resort inventory systems into
 * the offer shape the booking widget prices against:
 *
 *   { sku, name, category: 'ski' | 'snowboard' | 'bike', level, available, dailyRate, currency }
 */

const SUMMIT_CATEGORY = { SKI: 'ski', SNB: 'snowboard', BIKE: 'bike' };
const SUMMIT_LEVEL = { BEG: 'sport', INT: 'performance', ADV: 'demo', KID: 'kids', ALL: 'all' };
const GEAR_HUB_LEVEL = { beginner: 'sport', intermediate: 'performance', advanced: 'demo', kids: 'kids' };

function readSummitPos(payload) {
  return payload.skus.map((sku) => ({
    sku: sku.code,
    name: sku.desc,
    category: SUMMIT_CATEGORY[sku.cat] || sku.cat.toLowerCase(),
    level: SUMMIT_LEVEL[sku.lvl] || 'all',
    available: sku.qty_on_hand,
    dailyRate: sku.rate_cents / 100,
    currency: 'USD',
  }));
}

function readAlpineFleet(payload) {
  return payload.items.map((item) => ({
    sku: item.sku,
    name: item.name,
    category: item.category,
    level: item.tier,
    available: item.available,
    dailyRate: item.dailyRate,
    currency: 'USD',
  }));
}

function readGearHub(payload) {
  return Object.entries(payload.inventory).map(([sku, entry]) => ({
    sku,
    name: entry.label,
    category: entry.group,
    level: GEAR_HUB_LEVEL[entry.level] || 'all',
    available: entry.count,
    dailyRate: entry.price.amount,
    currency: entry.price.currency,
  }));
}

const SHAPE_READERS = {
  'summit-pos': readSummitPos,
  'alpine-fleet': readAlpineFleet,
  'gear-hub': readGearHub,
};

function normalizeInventory(source, payload) {
  const reader = SHAPE_READERS[source.system];
  if (!reader) {
    const error = new Error(`No inventory reader registered for system "${source.system}"`);
    error.code = 'UNKNOWN_INVENTORY_SYSTEM';
    throw error;
  }
  return reader(payload).filter((offer) => Number.isFinite(offer.available));
}

module.exports = { normalizeInventory, SHAPE_READERS };
