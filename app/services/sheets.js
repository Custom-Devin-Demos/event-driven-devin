const https = require('https');
const { URL } = require('url');

const logger = require('../telemetry/logger');

/**
 * Append one signup to a Google Sheet via a Google Apps Script Web App webhook.
 *
 * Setup (no Google API credentials / service account needed):
 *   1. In the target Sheet: Extensions -> Apps Script.
 *   2. Paste a doPost(e) that validates a shared token and appends a row.
 *   3. Deploy -> New deployment -> Web app (execute as you, access "Anyone").
 *   4. Set WEBINAR_SHEET_WEBHOOK_URL (the /exec URL) and
 *      WEBINAR_SHEET_WEBHOOK_TOKEN (the shared secret) in the environment.
 *
 * No-op (resolves { ok:false }) when the webhook is not configured, so it never
 * blocks or fails a registration. Resolves to { ok, status }.
 */
function appendSignup({ name, title, email, registeredAt }) {
  const webhookUrl = process.env.WEBINAR_SHEET_WEBHOOK_URL;
  const token = process.env.WEBINAR_SHEET_WEBHOOK_TOKEN || '';
  if (!webhookUrl) {
    logger.warn('sheets.append.skipped', { reason: 'missing webhook url' });
    return Promise.resolve({ ok: false, status: 0, error: 'not configured' });
  }

  let target;
  try {
    target = new URL(webhookUrl);
  } catch (err) {
    logger.warn('sheets.append.bad_url', { error: err.message });
    return Promise.resolve({ ok: false, status: 0, error: 'bad webhook url' });
  }

  const body = JSON.stringify({ token, name, title, email, registeredAt });

  return new Promise((resolve) => {
    const options = {
      host: target.host,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // Apps Script redirects (302) to a script.googleusercontent.com URL on
        // success; treat 2xx and 3xx as delivered.
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        if (ok) {
          logger.info('sheets.append.ok', { email, status: res.statusCode });
        } else {
          logger.warn('sheets.append.failed', { status: res.statusCode, body: data });
        }
        resolve({ ok, status: res.statusCode, body: data });
      });
    });
    req.on('error', (err) => {
      logger.warn('sheets.append.error', { error: err.message });
      resolve({ ok: false, status: 0, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

module.exports = { appendSignup };
