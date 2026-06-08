const logger = require('../app/telemetry/logger');

/**
 * Per-customer Devin configuration.
 *
 * Each entry maps a customer slug to its Devin trigger settings.
 * Customer slugs are passed via `alertData.customer` when calling
 * `createSessionAndAlert()`. If no customer is specified, the
 * "default" entry is used (which reads the global env vars).
 *
 * Adding a new customer:
 *   1. Add an entry here with a unique slug
 *   2. Set the corresponding env vars (suffixed with _<SLUG>)
 *   3. Pass `customer: '<slug>'` in the vertical's alertData
 *
 * Env var naming convention for customer-specific vars:
 *   DEVIN_API_KEY_<SLUG>       — Devin API key for that customer's org
 *   DEVIN_PLAYBOOK_ID_<SLUG>   — Optional playbook ID
 *   GITHUB_ORG_<SLUG>          — GitHub org for repo references
 *   DEVIN_USER_ID_<SLUG>       — Pre-configured Devin user ID
 *   SONAR_TARGET_REPO_<SLUG>   — Target repo for SonarCloud PR
 *
 * Example: For customer slug "a6b38c63":
 *   DEVIN_API_KEY_A6B38C63=dv-abc123...
 *   GITHUB_ORG_A6B38C63=SomeGitHubOrg
 *   DEVIN_USER_ID_A6B38C63=cog_user_123
 *   SONAR_TARGET_REPO_A6B38C63=SomeGitHubOrg/etl-pipeline-demo
 */
const CUSTOMERS = {
  default: {
    label: 'Default (landing page demos)',
    // Uses global env vars — no suffix
  },
  a6b38c63: {
    label: 'Customer A6B3',
    triggerMode: 'api',
  },
  ef5d1dc1: {
    label: 'Customer EF5D',
    triggerMode: 'api',
  },
  e0c16510: {
    label: 'Customer E0C1',
    triggerMode: 'api',
  },
  '53a9884e': {
    label: 'Customer 53A9',
    triggerMode: 'api',
  },
  acf4303d: {
    label: 'Customer ACF4',
    triggerMode: 'api',
  },
  f3ff1d33: {
    label: 'Customer F3FF',
    triggerMode: 'api',
  },
  '430a4200': {
    label: 'Customer 430A',
    triggerMode: 'api',
  },
  b62fa21d: {
    label: 'Customer B62F',
    triggerMode: 'api',
  },
  f2f54159: {
    label: 'Customer F2F5',
    triggerMode: 'api',
  },
  '304db83f': {
    label: 'Customer 304D',
    triggerMode: 'api',
  },
  '1a459b91': {
    label: 'Customer 1A45',
    triggerMode: 'api',
  },
  beb4d43e: {
    label: 'Customer BEB4',
    triggerMode: 'api',
  },
  '4feeb7bb': {
    label: 'Customer 4FEE',
    triggerMode: 'api',
  },
  '89c1f355': {
    label: 'Customer 89C1',
    triggerMode: 'api',
  },
  '99a8ba1a': {
    label: 'Customer 99A8',
    triggerMode: 'api',
  },
  'b3e22436': {
    label: 'Customer B3E2',
    triggerMode: 'api',
  },
  d5fc3172: {
    label: 'Customer D5FC',
    triggerMode: 'api',
  },
  c4a8e2b7: {
    label: 'Customer C4A8',
    triggerMode: 'api',
  },
  '7d2e9f4a': {
    label: 'Customer 7D2E',
    triggerMode: 'api',
  },
  b3587482: {
    label: 'Chick-fil-A',
    triggerMode: 'api',
  },
  levis: {
    label: "Levi's",
    triggerMode: 'api',
  },
  cocacola: {
    label: 'Coca-Cola',
    triggerMode: 'api',
  },
  homedepot: {
    label: 'The Home Depot',
    triggerMode: 'api',
  },
  lilly: {
    label: 'Eli Lilly',
    triggerMode: 'api',
  },
  bbva: {
    label: 'BBVA Banking',
    triggerMode: 'api',
  },
  bestbuy: {
    label: 'Best Buy',
    triggerMode: 'api',
  },
  sysco: {
    label: 'Sysco',
    triggerMode: 'api',
  },
  vfc: {
    label: 'VF Corporation',
    triggerMode: 'api',
  },
  visa: {
    label: 'Visa',
    triggerMode: 'api',
  },
  spglobal: {
    label: 'S&P Global',
    triggerMode: 'api',
  },
  '841afdc1': {
    label: 'Customer 841A',
    triggerMode: 'api',
  },
};

/**
 * Resolve the Devin configuration for a given customer.
 *
 * For the default customer, reads the standard global env vars.
 * For named customers, reads env vars with a _<SLUG> suffix,
 * falling back to the global env vars when the suffixed var is not set.
 *
 * Named customers default to triggerMode "api" (since the whole point
 * of per-customer config is running against a different Devin org).
 *
 * @param {string} [customerSlug] - Customer identifier (e.g. "wayfair")
 * @returns {Object} Resolved config with triggerMode, apiKey, playbookId, githubOrg, devinUserId, targetRepo
 */
function getCustomerConfig(customerSlug) {
  const slug = customerSlug || 'default';
  const entry = CUSTOMERS[slug] || CUSTOMERS.default;

  // For non-default customers, build a suffix from the slug
  // e.g. "wayfair" → "_WAYFAIR", "acme-corp" → "_ACME_CORP"
  const suffix = slug !== 'default'
    ? `_${slug.toUpperCase().replace(/-/g, '_')}`
    : '';

  // Non-default customers target Custom-Devin-Demos by default;
  // the default customer (landing page demos) targets COG-GTM.
  // For non-default customers, skip the global GITHUB_ORG env var
  // so it doesn't shadow the per-customer default.
  const githubOrg = slug !== 'default'
    ? (entry.githubOrg || process.env[`GITHUB_ORG${suffix}`] || 'Custom-Devin-Demos')
    : (entry.githubOrg || process.env.GITHUB_ORG || 'COG-GTM');

  const config = {
    customer: slug,
    label: entry.label || slug,
    triggerMode: 'api',
    apiKey: process.env[`DEVIN_SERVICE_KEY${suffix}`]
      || process.env.DEVIN_SERVICE_KEY
      || process.env[`DEVIN_API_KEY${suffix}`]
      || process.env.DEVIN_API_KEY || '',
    playbookId: process.env[`DEVIN_PLAYBOOK_ID${suffix}`]
      || process.env.DEVIN_PLAYBOOK_ID || '',
    githubOrg,
    devinUserId: process.env[`DEVIN_USER_ID${suffix}`]
      || process.env.DEVIN_USER_ID || '',
    targetRepo: process.env[`SONAR_TARGET_REPO${suffix}`]
      || process.env.SONAR_TARGET_REPO || `${githubOrg}/etl-pipeline-demo`,
  };

  if (slug !== 'default') {
    logger.info('Resolved customer-specific Devin config', {
      customer: slug,
      triggerMode: config.triggerMode,
      hasApiKey: !!config.apiKey,
      hasPlaybook: !!config.playbookId,
      githubOrg: config.githubOrg,
      hasDevinUserId: !!config.devinUserId,
      targetRepo: config.targetRepo,
    });
  }

  return config;
}

/**
 * List all registered customer slugs.
 * Useful for documentation and debugging.
 */
function listCustomers() {
  return Object.entries(CUSTOMERS).map(([slug, entry]) => ({
    slug,
    label: entry.label || slug,
    triggerMode: entry.triggerMode || (slug === 'default' ? 'env' : 'api'),
  }));
}

module.exports = {
  getCustomerConfig,
  listCustomers,
  CUSTOMERS,
};
