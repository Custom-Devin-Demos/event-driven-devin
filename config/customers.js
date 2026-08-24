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
  '46d4846d': {
    label: "Levi's",
    triggerMode: 'api',
  },
  '50b235c7': {
    label: 'lululemon',
    triggerMode: 'api',
  },
  e7c81c9e: {
    label: 'Nordstrom',
    triggerMode: 'api',
  },
  fdc0cc83: {
    label: 'Walmart',
    triggerMode: 'api',
  },
  eaa595e1: {
    label: 'Kroger',
    triggerMode: 'api',
  },
  b1c29f25: {
    label: 'Highmark Health',
    triggerMode: 'api',
  },
  '2a7a62a9': {
    label: 'Highmark enGen',
    triggerMode: 'api',
  },
  'cba5be2d': {
    label: 'Timberland',
    triggerMode: 'api',
  },
  '696ecb91': {
    label: 'Lingo by Abbott',
    triggerMode: 'api',
  },
  '74124a39': {
    label: 'Coca-Cola',
    triggerMode: 'api',
  },
  '91fe5a5f': {
    label: 'Target',
    triggerMode: 'api',
  },
  'eb2f4ad1': {
    label: 'The Home Depot',
    triggerMode: 'api',
  },
  'a131fea3': {
    label: "O'Reilly Auto Parts",
    triggerMode: 'api',
  },
  '8096ad15': {
    label: 'Eli Lilly',
    triggerMode: 'api',
  },
  '4886afe1': {
    label: 'BBVA Banking',
    triggerMode: 'api',
  },
  '6074332d': {
    label: 'Best Buy',
    triggerMode: 'api',
  },
  'eb3df102': {
    label: 'Sysco',
    triggerMode: 'api',
  },
  'f9296fb3': {
    label: 'VF Corporation',
    triggerMode: 'api',
  },
  '3699f348': {
    label: 'Visa',
    triggerMode: 'api',
  },
  '8491be2c': {
    label: 'S&P Global',
    triggerMode: 'api',
  },
  '841afdc1': {
    label: 'Customer 841A',
    triggerMode: 'api',
  },
  '6f543fa2': {
    label: 'BNSF Railway',
    triggerMode: 'api',
  },
  'f91c0df3': {
    label: 'Avis',
    triggerMode: 'api',
  },
  'bc6a7c34': {
    label: 'Electronic Arts',
    triggerMode: 'api',
  },
  '058419ac': {
    label: 'Optum Rx',
    triggerMode: 'api',
  },
  '31328569': {
    label: 'UnitedHealth Group',
    triggerMode: 'api',
  },
  '90a02f02': {
    label: 'Zup Innovation',
    triggerMode: 'api',
  },
  '058bcc4c': {
    label: 'Kraft Heinz',
    triggerMode: 'api',
  },
  'f5a355e7': {
    label: 'Loblaws',
    triggerMode: 'api',
  },
  'b683fdf3': {
    label: 'Walgreens',
    triggerMode: 'api',
  },
  '0141c475': {
    label: "Macy's",
    triggerMode: 'api',
  },
  '8d933e67': {
    label: 'TD Bank',
    triggerMode: 'api',
  },
  '6820f69a': {
    label: 'Fifth Third Bank',
    triggerMode: 'api',
  },
  'ac1752e4': {
    label: 'KeyBank',
    triggerMode: 'api',
  },
  '17dd6f6f': {
    label: 'Customer 17DD',
    triggerMode: 'api',
  },
  '08381313': {
    label: 'Customer 0838',
    triggerMode: 'api',
  },
  'df3f450c': {
    label: 'athenahealth',
    triggerMode: 'api',
  },
  'e433d32d': {
    label: 'Scotiabank',
    triggerMode: 'api',
  },
  '16ebec74': {
    label: 'Scotiabank Chile',
    triggerMode: 'api',
  },
  '4ada28b9': {
    label: 'Customer 4ADA',
    triggerMode: 'api',
  },
  'a8585092': {
    label: 'Bank of America',
    triggerMode: 'api',
  },
  '61875a84': {
    label: 'Bank of America Transactions',
    triggerMode: 'api',
  },
  ad960e6a: {
    label: 'Comcast Business',
    triggerMode: 'api',
  },
  bec5e1bb: {
    label: 'Telefónica',
    triggerMode: 'api',
  },
  '054f8313': {
    label: 'Banamex',
    triggerMode: 'api',
  },
  b98fcab6: {
    label: 'Customer B98F',
    triggerMode: 'api',
  },
  '91e30701': {
    label: 'Comarch',
    triggerMode: 'api',
  },
  '382b34fc': {
    label: 'GEICO',
    triggerMode: 'api',
  },
  c35ea2e0: {
    label: 'Terex',
    triggerMode: 'api',
  },
  '8b5893cb': {
    label: 'T. Rowe Price',
    triggerMode: 'api',
    githubOrg: 'COG-GTM',
  },
  '12b28f14': {
    label: 'Pepsi',
    triggerMode: 'api',
  },
  '220cee45': {
    label: 'Thermo Fisher Scientific',
    triggerMode: 'api',
  },
  '43f2f084': {
    label: 'Gap',
    triggerMode: 'api',
  },
  '383b99d1': {
    label: 'Gap Data Intelligence',
    triggerMode: 'api',
  },
  efbf4b55: {
    label: 'Customer EFBF',
    triggerMode: 'api',
  },
  '9309cd53': {
    label: 'ICRC (Red Cross Geneva)',
    triggerMode: 'api',
  },
  a1e178ae: {
    label: 'Louis Dreyfus Company Brazil',
    triggerMode: 'api',
  },
  'b9612d96': {
    label: 'Croda',
    triggerMode: 'api',
  },
  b634a963: {
    label: 'Customer B634',
    triggerMode: 'api',
  },
  unicaja: {
    label: 'Unicaja Digital Banking',
    triggerMode: 'api',
  },
  kraftheinz: {
    label: 'Kraft Heinz Distributor Orders',
    triggerMode: 'api',
  },
  '82df0421': {
    label: 'Customer 82DF',
    triggerMode: 'api',
  },
  '227b9feb': {
    label: 'Customer 227B',
    triggerMode: 'api',
  },
  '556bc104': {
    label: 'Customer 556B',
    triggerMode: 'api',
  },
  '6efdaec0': {
    label: 'Customer 6EFD',
    triggerMode: 'api',
  },
  f36ef02a: {
    label: 'Customer F36E',
    triggerMode: 'api',
  },
  caixabank: {
    label: 'CaixaBank Online Banking',
    triggerMode: 'api',
  },
  bbva: {
    label: 'BBVA Online Banking',
    triggerMode: 'api',
  },
  '5697165b': {
    label: 'Customer 5697',
    triggerMode: 'api',
  },
  '8c0e99b1': {
    label: 'Customer 8C0E',
    triggerMode: 'api',
  },
  chipotle: {
    label: 'Chipotle Order Ahead',
    triggerMode: 'api',
  },
  coppel: {
    label: 'Coppel Mi Carrito',
    triggerMode: 'api',
  },
  '49d841e8': {
    label: 'Customer 49D8',
    triggerMode: 'api',
  },
  '3cec99d4': {
    label: 'RBC Royal Bank',
    triggerMode: 'api',
  },
  '94f4c31f': {
    label: 'Citi Self Invest',
    triggerMode: 'api',
  },
  '4f9ede2a': {
    label: 'U.S. Bank Business Bill Pay',
    triggerMode: 'api',
  },
  b014618f: {
    label: 'Capital One Travel',
    triggerMode: 'api',
  },
  a69bcc34: {
    label: 'The Home Depot',
    triggerMode: 'api',
  },
  '0e015eed': {
    label: 'Tapestry',
    triggerMode: 'api',
  },
  cd83ac3c: {
    label: 'Staples',
    triggerMode: 'api',
  },
  '7e6bb001': {
    label: 'Humana',
    triggerMode: 'api',
  },
  ef58967c: {
    label: 'Charles Schwab',
    triggerMode: 'api',
  },
  f26260e1: {
    label: 'Customer F262',
    triggerMode: 'api',
  },
  e1da8ec4: {
    label: 'Customer E1DA',
    triggerMode: 'api',
  },
  '3d2ef497': {
    label: 'Customer 3D2E',
    triggerMode: 'api',
  },
  '3c3e0371': {
    label: 'Customer 3C3E',
    triggerMode: 'api',
  },
  '40cf3e09': {
    label: 'Customer 40CF',
    triggerMode: 'api',
  },
  '87127748': {
    label: 'Customer 8712',
    triggerMode: 'api',
  },
  da6578ee: {
    label: 'S&P Global MI — Feed Migration',
    triggerMode: 'api',
  },
  '6c89c6b0': {
    label: 'Procurement Resources Library',
    triggerMode: 'api',
  },
  '88ad5a84': {
    label: 'RBC Online Banking',
    triggerMode: 'api',
  },
  '718eb882': {
    label: 'Huntington Online Banking',
    triggerMode: 'api',
  },
  '2ef89b23': {
    label: 'FIS Payments One',
    triggerMode: 'api',
  },
  '9db3d08f': {
    label: 'Insurance Claims Workspace',
    triggerMode: 'api',
  },
  mtb: {
    label: 'M&T Bank Online Banking',
    triggerMode: 'api',
  },
  '15fee237': {
    label: 'Morgan Stanley',
    triggerMode: 'api',
  },
  '6a766bce': {
    label: 'AECOM Project Portfolio',
    triggerMode: 'api',
  },
  edaa5b9f: {
    label: 'Disney Guest Contact',
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
    sonarWorkflowCustomer: process.env[`SONAR_WORKFLOW_CUSTOMER${suffix}`] || slug,
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
      sonarWorkflowCustomer: config.sonarWorkflowCustomer,
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
