const axios = require('axios');
const logger = require('../telemetry/logger');

const DEVIN_API_BASE = 'https://api.devin.ai';

// Maximum number of items per page (Devin v3 API cap)
const PAGE_SIZE = 200;
// Safety limit on total pages to prevent infinite loops
const MAX_PAGES = 50;

/**
 * Generic paginated fetcher for Devin v3 list endpoints.
 *
 * Follows cursor-based pagination using `first` / `after` query params.
 * The response is expected to contain:
 *   - `items`          — array of results for the current page
 *   - `has_next_page`  — boolean indicating more pages exist
 *   - `end_cursor`     — opaque cursor to pass as `after` for the next page
 *
 * @param {string} url - Full endpoint URL
 * @param {Object} headers - Request headers (including Authorization)
 * @param {Object} [extraParams] - Additional query params (e.g. { role: 'admin' })
 * @returns {Array} - All items across every page
 */
async function fetchAllPages(url, headers, extraParams = {}) {
  const allItems = [];
  let cursor = undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { first: PAGE_SIZE, ...extraParams };
    if (cursor) {
      params.after = cursor;
    }

    const response = await axios.get(url, {
      headers,
      timeout: 15000,
      params,
    });

    const items = response.data.items || [];
    allItems.push(...items);

    if (!response.data.has_next_page || !response.data.end_cursor) {
      break;
    }
    cursor = response.data.end_cursor;
  }

  return allItems;
}

/**
 * Resolve the service key and org ID for Devin v3 API calls.
 *
 * The v3 Organization API requires:
 *   - A service user credential (cog_ prefix) for authentication
 *   - The org ID to scope requests to the correct organization
 *
 * Falls back to DEVIN_API_KEY for backward-compat during migration.
 */
function resolveServiceAuth(options = {}) {
  const serviceKey = options.apiKey
    || process.env.DEVIN_SERVICE_KEY
    || process.env.DEVIN_API_KEY || '';
  const orgId = options.orgId || process.env.DEVIN_ORG_ID || '';
  return { serviceKey, orgId };
}

/**
 * Create a Devin session via the v3 Organization API.
 *
 * Calls POST /v3/organizations/{org_id}/sessions with the investigation prompt.
 * Returns the session URL so it can be linked in Slack alerts.
 *
 * When `userId` is provided, the session is created on behalf of that user
 * via the `create_as_user_id` parameter, so it shows up in their personal
 * Devin account rather than the service user's account.
 *
 * @param {string} prompt - The investigation prompt for Devin
 * @param {Object} [options] - Per-customer overrides
 * @param {string} [options.apiKey] - Override the default service key
 * @param {string} [options.orgId] - Override the default org ID (for multi-org support)
 * @param {string} [options.userId] - Devin user ID to create the session as
 * @param {string} [options.playbookId] - Playbook ID to attach to the session
 * @returns {Object|null} - { sessionId, url } or null if failed/not configured
 */
async function createDevinSession(prompt, options = {}) {
  const { serviceKey, orgId } = resolveServiceAuth(options);

  if (!serviceKey) {
    logger.warn('DEVIN_SERVICE_KEY not configured — skipping Devin session creation');
    return null;
  }

  if (!orgId) {
    logger.warn('DEVIN_ORG_ID not configured — skipping Devin session creation');
    return null;
  }

  try {
    const body = { prompt };

    // Attach playbook so Devin follows the structured investigation workflow
    if (options.playbookId) {
      body.playbook_id = options.playbookId;
    }

    // Create session on behalf of a specific user so it appears in their account
    if (options.userId) {
      body.create_as_user_id = options.userId;
    }

    const response = await axios.post(
      `${DEVIN_API_BASE}/v3/organizations/${orgId}/sessions`,
      body,
      {
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    );

    const sessionId = response.data.session_id;
    const url = response.data.url || `https://app.devin.ai/sessions/${sessionId}`;

    logger.info('Devin session created via v3 API', {
      sessionId,
      url,
      userId: options.userId || 'service-user',
      playbookId: options.playbookId || 'none',
    });

    return { sessionId, url };
  } catch (error) {
    logger.error('Failed to create Devin session via v3 API', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return null;
  }
}

/**
 * List organizations in the enterprise.
 *
 * Calls GET /v3/enterprise/organizations to retrieve all orgs.
 * The service user needs ManageOrganizations permission.
 *
 * Falls back to DEVIN_ORG_LIST env var (JSON array) if the API call fails.
 *
 * @returns {Array} - Array of { org_id, name } objects
 */
async function listEnterpriseOrgs() {
  const { serviceKey } = resolveServiceAuth();

  if (serviceKey) {
    try {
      const items = await fetchAllPages(
        `${DEVIN_API_BASE}/v3/enterprise/organizations`,
        { Authorization: `Bearer ${serviceKey}` },
      );

      const orgs = items.map((o) => ({
        org_id: o.org_id,
        name: o.name || o.org_id,
      }));

      logger.info('Fetched enterprise orgs from Devin API', { count: orgs.length });
      return orgs;
    } catch (error) {
      logger.warn('Failed to fetch enterprise orgs — falling back to env config', {
        error: error.message,
        status: error.response?.status,
      });
    }
  }

  // Fallback: read from DEVIN_ORG_LIST env var (JSON array)
  const envOrgs = process.env.DEVIN_ORG_LIST;
  if (envOrgs) {
    try {
      const orgs = JSON.parse(envOrgs);
      logger.info('Loaded enterprise orgs from DEVIN_ORG_LIST env var', { count: orgs.length });
      return orgs;
    } catch (parseErr) {
      logger.error('Failed to parse DEVIN_ORG_LIST env var', { error: parseErr.message });
    }
  }

  // Last resort: return the single configured org with a friendly name
  const defaultOrgId = process.env.DEVIN_ORG_ID;
  if (defaultOrgId) {
    const defaultName = process.env.DEVIN_ORG_NAME || 'Devin GTM';
    return [{ org_id: defaultOrgId, name: defaultName }];
  }

  return [];
}

/**
 * List users in a Devin organization.
 *
 * Calls GET /v3/enterprise/organizations/{org_id}/members/users to retrieve
 * all members of the org. The service user needs ManageAccountMembership
 * permission for this endpoint.
 *
 * Falls back to DEVIN_ORG_USERS env var (JSON array) if the API call fails
 * or the service user lacks permissions.
 *
 * @param {string} [orgId] - Override the default org ID
 * @returns {Array} - Array of { user_id, name, email } objects
 */
async function listOrgUsers(orgId) {
  const { serviceKey, orgId: defaultOrgId } = resolveServiceAuth();
  const targetOrgId = orgId || defaultOrgId;

  // Try the API first
  if (serviceKey && targetOrgId) {
    try {
      const items = await fetchAllPages(
        `${DEVIN_API_BASE}/v3/enterprise/organizations/${targetOrgId}/members/users`,
        { Authorization: `Bearer ${serviceKey}` },
      );

      const users = items.map((u) => ({
        user_id: u.user_id,
        name: u.name || u.email,
        email: u.email,
      }));

      logger.info('Fetched org users from Devin API', { count: users.length });
      return users;
    } catch (error) {
      logger.warn('Failed to fetch org users from Devin API — falling back to env config', {
        error: error.message,
        status: error.response?.status,
      });
    }
  }

  // Fallback: read from DEVIN_ORG_USERS env var (JSON array)
  const envUsers = process.env.DEVIN_ORG_USERS;
  if (envUsers) {
    try {
      const users = JSON.parse(envUsers);
      logger.info('Loaded org users from DEVIN_ORG_USERS env var', { count: users.length });
      return users;
    } catch (parseErr) {
      logger.error('Failed to parse DEVIN_ORG_USERS env var', { error: parseErr.message });
    }
  }

  return [];
}

/**
 * List enterprise-level admin users.
 *
 * Calls GET /v3/enterprise/members/users to retrieve all enterprise admins.
 * These users can view every org even if they aren't explicitly org members.
 *
 * Falls back to DEVIN_ENTERPRISE_ADMINS env var (JSON array) if the API call
 * fails or the service user lacks permissions.
 *
 * @returns {Array} - Array of { user_id, name, email, is_enterprise_admin } objects
 */
async function listEnterpriseAdmins() {
  const { serviceKey } = resolveServiceAuth();

  if (serviceKey) {
    try {
      const items = await fetchAllPages(
        `${DEVIN_API_BASE}/v3/enterprise/members/users`,
        { Authorization: `Bearer ${serviceKey}` },
        { role: 'admin' },
      );

      const admins = items.map((u) => ({
        user_id: u.user_id,
        name: u.name || u.email,
        email: u.email,
        is_enterprise_admin: true,
      }));

      logger.info('Fetched enterprise admins from Devin API', { count: admins.length });
      return admins;
    } catch (error) {
      logger.warn('Failed to fetch enterprise admins — falling back to env config', {
        error: error.message,
        status: error.response?.status,
      });
    }
  }

  // Fallback: read from DEVIN_ENTERPRISE_ADMINS env var (JSON array)
  const envAdmins = process.env.DEVIN_ENTERPRISE_ADMINS;
  if (envAdmins) {
    try {
      const admins = JSON.parse(envAdmins).map((u) => ({
        ...u,
        is_enterprise_admin: true,
      }));
      logger.info('Loaded enterprise admins from DEVIN_ENTERPRISE_ADMINS env var', { count: admins.length });
      return admins;
    } catch (parseErr) {
      logger.error('Failed to parse DEVIN_ENTERPRISE_ADMINS env var', { error: parseErr.message });
    }
  }

  return [];
}

module.exports = {
  createDevinSession,
  listEnterpriseOrgs,
  listOrgUsers,
  listEnterpriseAdmins,
};
