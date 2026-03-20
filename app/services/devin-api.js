const axios = require('axios');
const logger = require('../telemetry/logger');

const DEVIN_API_BASE = 'https://api.devin.ai/v1';

/**
 * Create a Devin session via the API.
 *
 * Calls POST /v1/sessions with the investigation prompt.
 * Returns the session URL so it can be linked in Slack alerts.
 *
 * The prompt itself contains the !sentry_investigation playbook macro,
 * so there is no need to pass a separate playbook_id to the API.
 *
 * Accepts an optional `options` object for per-customer overrides:
 *   - options.apiKey — override the default DEVIN_API_KEY
 *
 * @param {string} prompt - The investigation prompt for Devin
 * @param {Object} [options] - Per-customer overrides
 * @returns {Object|null} - { sessionId, url } or null if failed/not configured
 */
async function createDevinSession(prompt, options = {}) {
  const apiKey = options.apiKey || process.env.DEVIN_API_KEY;
  if (!apiKey) {
    logger.warn('DEVIN_API_KEY not configured — skipping Devin session creation');
    return null;
  }

  try {
    const body = { prompt };

    const response = await axios.post(`${DEVIN_API_BASE}/sessions`, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    const sessionId = response.data.session_id;
    const url = response.data.url || `https://app.devin.ai/sessions/${sessionId}`;

    logger.info('Devin session created via API', { sessionId, url });

    return { sessionId, url };
  } catch (error) {
    logger.error('Failed to create Devin session via API', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return null;
  }
}

module.exports = {
  createDevinSession,
};
