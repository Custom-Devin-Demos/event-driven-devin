const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Style profiles with scoring weights
 */
const STYLE_PROFILES = {
  modern: { factor: 1.3, tags: ['clean-lines', 'minimal', 'neutral'] },
  traditional: { factor: 1.0, tags: ['ornate', 'warm', 'classic'] },
  farmhouse: { factor: 1.15, tags: ['rustic', 'natural', 'cozy'] },
  contemporary: { factor: 1.25, tags: ['bold', 'mixed', 'eclectic'] },
};

/**
 * Product catalog for recommendations
 */
const ROOM_PRODUCTS = [
  { sku: 'WF-2840', name: 'Aria Tufted Velvet Sofa', room: 'living-room', price: 1299.99, rating: 4.7, tags: ['clean-lines', 'neutral'] },
  { sku: 'WF-3921', name: 'Harper Extendable Dining Table', room: 'dining-room', price: 849.50, rating: 4.5, tags: ['warm', 'classic'] },
  { sku: 'WF-1055', name: 'Luna Globe Pendant Light', room: 'living-room', price: 189.99, rating: 4.8, tags: ['minimal', 'clean-lines'] },
  { sku: 'WF-4472', name: 'Oakley Platform Bed Frame', room: 'bedroom', price: 699.00, rating: 4.6, tags: ['rustic', 'natural'] },
  { sku: 'WF-5583', name: 'Carrara Marble Side Table', room: 'living-room', price: 249.99, rating: 4.4, tags: ['bold', 'mixed'] },
  { sku: 'WF-6194', name: 'Nora Linen Accent Chair', room: 'living-room', price: 549.99, rating: 4.3, tags: ['cozy', 'neutral'] },
  { sku: 'WF-7201', name: 'Artisan Ceramic Vase Set', room: 'dining-room', price: 79.99, rating: 4.9, tags: ['rustic', 'warm'] },
  { sku: 'WF-8830', name: 'Handwoven Wool Area Rug 8x10', room: 'bedroom', price: 399.00, rating: 4.5, tags: ['natural', 'cozy'] },
  { sku: 'WF-9102', name: 'Ergonomic Mesh Desk Chair', room: 'home-office', price: 329.99, rating: 4.6, tags: ['clean-lines', 'minimal'] },
  { sku: 'WF-9340', name: 'Walnut Standing Desk', room: 'home-office', price: 579.00, rating: 4.4, tags: ['natural', 'clean-lines'] },
  { sku: 'WF-1120', name: 'Velvet Storage Ottoman', room: 'bedroom', price: 159.99, rating: 4.7, tags: ['cozy', 'classic'] },
  { sku: 'WF-2250', name: 'Industrial Bookshelf', room: 'home-office', price: 289.99, rating: 4.3, tags: ['bold', 'mixed', 'rustic'] },
];

/**
 * Match products to a room type and compute tag overlap scores.
 */
function matchProducts(roomType, styleTags) {
  const roomItems = ROOM_PRODUCTS.filter(p => p.room === roomType);
  return roomItems.map(product => {
    const overlap = product.tags.filter(t => styleTags.includes(t));
    return { item: product, tagScore: overlap.length / styleTags.length };
  });
}

/**
 * Rank matched products by applying the style factor to the tag score.
 */
function rankByStyle(matchedProducts, styleFactor) {
  return matchedProducts
    .map(entry => ({
      sku: entry.sku,
      name: entry.name,
      price: entry.price,
      rating: entry.rating,
      score: entry.tagScore * styleFactor * (entry.rating || 0),
      styleTags: entry.tags.slice(),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Format ranked products into a recommendation response.
 */
function formatRecommendation(rankedProducts, budget) {
  const affordable = rankedProducts.filter(p => p.price <= budget);
  const topPicks = affordable.slice(0, 3);
  return {
    recommendations: topPicks.map(p => ({
      product: p.name,
      price: `$${p.price.toFixed(2)}`,
      matchScore: Math.round(p.score * 100),
      verdict: p.score > 0.5 ? 'Great Match' : 'Good Option',
    })),
    totalFound: affordable.length,
  };
}

/**
 * Process a style recommendation request.
 */
async function getStyleRecommendations(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing style recommendations', {
    requestId,
    room: data.room,
    style: data.style,
    budget: data.budget,
    service: 'customer-a6b38c63-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const profile = STYLE_PROFILES[data.style];
    if (!profile) throw new Error(`Unknown style: ${data.style}`);

    const matched = matchProducts(data.room, profile.tags);
    const ranked = rankByStyle(matched, profile.factor);
    const result = formatRecommendation(ranked, data.budget);

    const duration = Date.now() - startTime;

    incrementMetric('recommendations.success', {
      route: '/api/a6b38c63/recommendations',
      style: data.style,
    });
    recordTiming('recommendations.latency', duration, {
      route: '/api/a6b38c63/recommendations',
    });

    return {
      success: true,
      requestId,
      room: data.room,
      style: data.style,
      ...result,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('recommendations.failure', {
      route: '/api/a6b38c63/recommendations',
      errorClass: error.name,
      style: data.style,
    });
    recordTiming('recommendations.latency', duration, {
      route: '/api/a6b38c63/recommendations',
      error: 'true',
    });

    logger.error('Recommendation failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      room: data.room,
      style: data.style,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/a6b38c63/recommendations',
        service: 'customer-a6b38c63-api',
        style: data.style,
      },
      extra: {
        requestId,
        room: data.room,
        style: data.style,
        budget: data.budget,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/a6b38c63.js — getStyleRecommendations',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      service: 'customer-a6b38c63-api',
      verticalLabel: 'Wayfair Style Recommendations',
      customer: 'a6b38c63',
      tags: [
        { key: 'route', value: '/api/a6b38c63/recommendations' },
        { key: 'service', value: 'customer-a6b38c63-api' },
        { key: 'style', value: data.style },
      ],
      extra: { requestId, room: data.room, style: data.style, budget: data.budget },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'wayfair@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from recommendation error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { getStyleRecommendations, ROOM_PRODUCTS, STYLE_PROFILES };
