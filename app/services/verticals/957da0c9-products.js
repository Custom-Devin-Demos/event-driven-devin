/**
 * Product catalog for the 957da0c9 homepage quote flow.
 *
 * Every entry point on the homepage (nav, "I am..." segments, product cards,
 * quote widget, learning-center links) resolves to one of these products so a
 * single quote request can be priced regardless of which tile was clicked.
 */

const PRODUCT_CATALOG = Object.freeze([
  { code: 'LIFE', name: 'Life insurance', ratingBasis: 'term-life', defaultTerm: 20 },
  { code: 'DISABILITY', name: 'Disability insurance', ratingBasis: 'income-protection', defaultTerm: 10 },
  { code: 'DENTAL', name: 'Dental insurance', ratingBasis: 'dental-ppo', defaultTerm: 1 },
  { code: 'VISION', name: 'Vision insurance', ratingBasis: 'vision-plan', defaultTerm: 1 },
  { code: 'ACCIDENT', name: 'Accident insurance', ratingBasis: 'accident-indemnity', defaultTerm: 1 },
  { code: 'RETIREMENT', name: 'Annuities & retirement', ratingBasis: 'fixed-annuity', defaultTerm: 10 },
]);

const INTENT_TO_PRODUCT = Object.freeze({
  individual: 'LIFE',
  employer: 'DISABILITY',
  broker: 'DENTAL',
  'dental-provider': 'DENTAL',
  'financial-professional': 'RETIREMENT',
  insurance: 'LIFE',
  investments: 'RETIREMENT',
  resources: 'LIFE',
  about: 'LIFE',
  'mental-wellness': 'DISABILITY',
  'critical-illness': 'ACCIDENT',
  'hospital-indemnity': 'ACCIDENT',
  annuities: 'RETIREMENT',
  'learning-center': 'LIFE',
  accolades: 'LIFE',
  fraud: 'LIFE',
  login: 'LIFE',
  footer: 'LIFE',
});

function resolveProduct(selection) {
  const raw = String(selection || '').trim().toLowerCase();
  const byCode = PRODUCT_CATALOG.find((p) => p.code.toLowerCase() === raw);
  if (byCode) return byCode;
  const mapped = INTENT_TO_PRODUCT[raw] || 'LIFE';
  return PRODUCT_CATALOG.find((p) => p.code === mapped);
}

module.exports = { PRODUCT_CATALOG, INTENT_TO_PRODUCT, resolveProduct };
