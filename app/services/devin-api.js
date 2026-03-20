const axios = require('axios');
const logger = require('../telemetry/logger');

const DEVIN_API_BASE = 'https://api.devin.ai';

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
      const response = await axios.get(
        `${DEVIN_API_BASE}/v3/enterprise/organizations`,
        {
          headers: { Authorization: `Bearer ${serviceKey}` },
          timeout: 10000,
          params: { first: 200 },
        },
      );

      const orgs = (response.data.items || []).map((o) => ({
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
      const response = await axios.get(
        `${DEVIN_API_BASE}/v3/enterprise/organizations/${targetOrgId}/members/users`,
        {
          headers: {
            Authorization: `Bearer ${serviceKey}`,
          },
          timeout: 10000,
          params: { first: 200 },
        },
      );

      const users = (response.data.items || []).map((u) => ({
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

module.exports = {
  createDevinSession,
  listEnterpriseOrgs,
  listOrgUsers,
};
