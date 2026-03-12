const { isScenarioActive, getScenario } = require('../incidentModes');
const logger = require('../telemetry/logger');
const { incrementMetric, recordTiming } = require('../telemetry/datadog');

const CATALOG = [
  { id: 'WIDGET-001', name: 'Premium Widget', price: 29.99, category: 'widgets' },
  { id: 'WIDGET-002', name: 'Standard Widget', price: 19.99, category: 'widgets' },
  { id: 'GADGET-001', name: 'Super Gadget', price: 49.99, category: 'gadgets' },
  { id: 'GADGET-002', name: 'Mini Gadget', price: 14.99, category: 'gadgets' },
  { id: 'TOOL-001', name: 'Power Tool Pro', price: 89.99, category: 'tools' },
  { id: 'TOOL-002', name: 'Precision Tool', price: 59.99, category: 'tools' },
  { id: 'ACC-001', name: 'Widget Accessory Kit', price: 9.99, category: 'accessories' },
  { id: 'ACC-002', name: 'Gadget Carrying Case', price: 24.99, category: 'accessories' },
];

async function searchProducts(query, persona) {
  const startTime = Date.now();
  const scenario = getScenario();

  logger.info('Search request', {
    query,
    persona,
    scenario,
    route: '/search',
  });

  // Simulate slow-db on search as well
  if (isScenarioActive('slow-db')) {
    const delay = 1500 + Math.random() * 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
    logger.warn('Slow search query', { query, delayMs: Math.round(delay), scenario: 'slow-db' });
  }

  // Normal processing delay
  await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 100));

  const q = (query || '').toLowerCase();
  const results = q
    ? CATALOG.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q)
      )
    : CATALOG;

  const duration = Date.now() - startTime;

  incrementMetric('search.requests', {
    route: '/search',
    persona: persona || 'unknown',
    resultCount: String(results.length),
  });
  recordTiming('search.latency', duration, {
    route: '/search',
    persona: persona || 'unknown',
  });

  logger.info('Search completed', {
    query,
    resultCount: results.length,
    durationMs: duration,
    scenario,
  });

  return {
    query,
    results,
    count: results.length,
    searchTime: duration,
  };
}

module.exports = { searchProducts };
