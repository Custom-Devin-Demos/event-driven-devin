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

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    let response;
    try {
      response = await axios.post(`${DEVIN_API_BASE}/sessions`, body, {
        headers,
        timeout: 15000,
      });
    } catch (firstError) {
      // If the playbook ID was rejected (400), retry without it so the session
      // is still created.  This handles stale / mis-configured playbook IDs
      // without silently swallowing other errors.
      const isPlaybookError =
        firstError.response?.status === 400 &&
        playbook &&
        /playbook/i.test(JSON.stringify(firstError.response?.data || ''));

      if (isPlaybookError) {
        logger.warn('Playbook ID rejected by Devin API — retrying without playbook', {
          playbookId: playbook,
          detail: firstError.response?.data?.detail,
        });

        delete body.playbook_id;
        response = await axios.post(`${DEVIN_API_BASE}/sessions`, body, {
          headers,
          timeout: 15000,
        });
      } else {
        throw firstError;
      }
    }

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
