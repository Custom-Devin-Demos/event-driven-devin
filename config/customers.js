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
 *   DEVIN_SLACK_USER_ID_<SLUG> — Slack user ID (only for slack trigger mode)
 *   SONAR_TARGET_REPO_<SLUG>   — Target repo for SonarCloud PR
 *
 * Example: For customer slug "wayfair":
 *   DEVIN_API_KEY_WAYFAIR=dv-abc123...
 *   SONAR_TARGET_REPO_WAYFAIR=COG-GTM/wayfair-etl-pipeline
 */
const CUSTOMERS = {
  default: {
    label: 'Default (landing page demos)',
    // Uses global env vars — no suffix
  },
  wayfair: {
    label: 'Wayfair',
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
 * @returns {Object} Resolved config with triggerMode, apiKey, playbookId, slackUserId, targetRepo
 */
function getCustomerConfig(customerSlug) {
  const slug = customerSlug || 'default';
  const entry = CUSTOMERS[slug] || CUSTOMERS.default;

  // For non-default customers, build a suffix from the slug
  // e.g. "wayfair" → "_WAYFAIR", "acme-corp" → "_ACME_CORP"
  const suffix = slug !== 'default'
    ? `_${slug.toUpperCase().replace(/-/g, '_')}`
    : '';

  const config = {
    customer: slug,
    label: entry.label || slug,
    triggerMode: entry.triggerMode
      || (suffix ? 'api' : (process.env.DEVIN_TRIGGER_MODE || 'slack')),
    apiKey: process.env[`DEVIN_API_KEY${suffix}`]
      || process.env.DEVIN_API_KEY || '',
    playbookId: process.env[`DEVIN_PLAYBOOK_ID${suffix}`]
      || process.env.DEVIN_PLAYBOOK_ID || '',
    slackUserId: process.env[`DEVIN_SLACK_USER_ID${suffix}`]
      || process.env.DEVIN_SLACK_USER_ID || 'U08RNEJ4877',
    targetRepo: process.env[`SONAR_TARGET_REPO${suffix}`]
      || process.env.SONAR_TARGET_REPO || 'COG-GTM/etl-pipeline-demo',
  };

  if (slug !== 'default') {
    logger.info('Resolved customer-specific Devin config', {
      customer: slug,
      triggerMode: config.triggerMode,
      hasApiKey: !!config.apiKey,
      hasPlaybook: !!config.playbookId,
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
