const axios = require('axios');
const logger = require('../telemetry/logger');

const DEVIN_API_BASE = 'https://api.devin.ai/v1';

/**
 * Create a Devin session via the API.
 *
 * Calls POST /v1/sessions with the investigation prompt.
 * Returns the session URL so it can be linked in Slack alerts.
 *
 * Accepts an optional `options` object for per-customer overrides:
 *   - options.apiKey     — override the default DEVIN_API_KEY
 *   - options.playbookId — override the default DEVIN_PLAYBOOK_ID
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

    // Include playbook if configured
    const playbook = options.playbookId || process.env.DEVIN_PLAYBOOK_ID;
    if (playbook) {
      body.playbook_id = playbook;
    }

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
