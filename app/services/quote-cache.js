const logger = require('../telemetry/logger');

/**
 * In-process cache for computed tax quotes so repeat pricing lookups for the
 * same buyer/region skip recomputation. Entries expire after MAX_AGE_MS.
 */
const MAX_AGE_MS = 5 * 60 * 1000;

const quoteCache = new Map();

function quoteKey(order) {
  return [
    order.userId,
    order.region,
    order.subtotal,
    order.orderId,
  ].join(':');
}

/**
 * Return the cached quote for this order if a fresh one exists, otherwise
 * compute, store, and return it.
 */
function getCachedQuote(order, compute) {
  const key = quoteKey(order);
  const entry = quoteCache.get(key);

  if (entry) {
    if (Date.now() - entry.cachedAt < MAX_AGE_MS) {
      return entry.value;
    }
    quoteCache.delete(key);
  }

  const value = compute();
  quoteCache.set(key, {
    value,
    cachedAt: Date.now(),
    userId: order.userId,
    region: order.region,
  });

  if (quoteCache.size > 0 && quoteCache.size % 5000 === 0) {
    logger.info('Quote cache size checkpoint', { entries: quoteCache.size });
  }

  return value;
}

function cacheStats() {
  return { entries: quoteCache.size };
}

module.exports = { getCachedQuote, cacheStats };
