const fs = require('fs');
const path = require('path');
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
 *   1. Create config/customers/<slug>.js exporting { label, triggerMode, aliases? }
 *   2. Set the corresponding env vars (suffixed with _<SLUG>) in .env
 *   3. Pass `customer: '<slug>'` in the vertical's alertData
 *
 * Env var naming convention for customer-specific vars:
 *   DEVIN_API_KEY_<SLUG>       — Devin API key for that customer's org
 *   DEVIN_PLAYBOOK_ID_<SLUG>   — Optional playbook ID
 *   GITHUB_ORG_<SLUG>          — GitHub org for repo references
 *   DEVIN_USER_ID_<SLUG>       — Pre-configured Devin user ID
 *   SONAR_TARGET_REPO_<SLUG>   — Target repo for SonarCloud PR
 *   SONAR_WORKFLOW_CUSTOMER_<SLUG> — Customer value passed to the devin-scan
 *                                    workflow dispatch (controls which service
 *                                    key the workflow uses; defaults to slug)
 *
 * Example: For customer slug "a6b38c63":
 *   DEVIN_API_KEY_A6B38C63=dv-abc123...
 *   GITHUB_ORG_A6B38C63=SomeGitHubOrg
 *   DEVIN_USER_ID_A6B38C63=cog_user_123
 *   SONAR_TARGET_REPO_A6B38C63=SomeGitHubOrg/etl-pipeline-demo
 */
const CUSTOMERS_DIR = path.join(__dirname, 'customers');

/**
 * Registry of customer entries, keyed by slug.
 *
 * `default` is defined inline; every other entry is loaded from
 * `config/customers/<slug>.js`, so adding a customer never edits a shared file.
 * An entry may also carry `aliases: ['friendly-url', ...]` — friendly paths that
 * serve `app/public/verticals/<slug>.html` (see app/routes/verticals/index.js).
 */
const CUSTOMERS = {
  default: {
    label: 'Default (landing page demos)',
    // Uses global env vars — no suffix
  },
};

for (const file of fs.readdirSync(CUSTOMERS_DIR).sort()) {
  if (!file.endsWith('.js')) continue;
  const slug = file.slice(0, -3);
  if (slug === 'default') {
    throw new Error(`config/customers/${file}: "default" is reserved; define it inline in config/customers.js`);
  }
  const entry = require(path.join(CUSTOMERS_DIR, file));
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`config/customers/${file} must export an object`);
  }
  CUSTOMERS[slug] = entry;
}

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
 * @returns {Object} Resolved config with triggerMode, apiKey, playbookId, githubOrg, devinUserId, devinOrgId, targetRepo
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
    // Org the per-customer service key belongs to; createDevinSession() falls back to DEVIN_ORG_ID.
    devinOrgId: suffix ? (process.env[`DEVIN_ORG_ID${suffix}`] || '') : '',
    targetRepo: process.env[`SONAR_TARGET_REPO${suffix}`]
      || process.env.SONAR_TARGET_REPO || `${githubOrg}/etl-pipeline-demo`,
    sonarWorkflowCustomer: process.env[`SONAR_WORKFLOW_CUSTOMER${suffix}`] || slug,
    itsm: entry.itsm || null,
    itsmAssignmentGroup: entry.itsmAssignmentGroup || '',
  };

  if (slug !== 'default') {
    logger.info('Resolved customer-specific Devin config', {
      customer: slug,
      triggerMode: config.triggerMode,
      hasApiKey: !!config.apiKey,
      hasPlaybook: !!config.playbookId,
      githubOrg: config.githubOrg,
      hasDevinUserId: !!config.devinUserId,
      hasDevinOrgId: !!config.devinOrgId,
      targetRepo: config.targetRepo,
      sonarWorkflowCustomer: config.sonarWorkflowCustomer,
      itsm: config.itsm,
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

/**
 * Friendly-URL aliases declared by customer entries, as { alias: slug }.
 * Throws when two entries claim the same alias.
 */
function listAliases() {
  const aliases = {};
  for (const [slug, entry] of Object.entries(CUSTOMERS)) {
    for (const alias of entry.aliases || []) {
      if (aliases[alias] && aliases[alias] !== slug) {
        throw new Error(`Alias "/${alias}" is claimed by both ${aliases[alias]} and ${slug}`);
      }
      aliases[alias] = slug;
    }
  }
  return aliases;
}

module.exports = {
  getCustomerConfig,
  listCustomers,
  listAliases,
  CUSTOMERS,
};
