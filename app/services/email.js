const crypto = require('crypto');
const https = require('https');

const logger = require('../telemetry/logger');

const REGION = process.env.AWS_SES_REGION || process.env.AWS_REGION || 'us-east-1';
const SERVICE = 'ses';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Send an email via the AWS SES v2 SendEmail API, signed with SigV4.
 * Uses AWS credentials from the environment. Resolves to { ok, status }.
 */
function sendEmail({ from, to, subject, text }) {
  return new Promise((resolve) => {
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKey || !secretKey) {
      logger.warn('email.send.skipped', { reason: 'missing AWS credentials' });
      return resolve({ ok: false, status: 0, error: 'missing AWS credentials' });
    }

    const host = `email.${REGION}.amazonaws.com`;
    const path = '/v2/email/outbound-emails';
    const body = JSON.stringify({
      FromEmailAddress: from,
      Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' } },
        },
      },
    });

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);

    const sessionToken = process.env.AWS_SESSION_TOKEN;
    let canonicalHeaders =
      `content-type:application/json\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    let signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    // Temporary credentials require x-amz-security-token to be signed too.
    if (sessionToken) {
      canonicalHeaders += `x-amz-security-token:${sessionToken}\n`;
      signedHeaders += ';x-amz-security-token';
    }
    const canonicalRequest = [
      'POST',
      path,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', signingKey(secretKey, dateStamp, REGION, SERVICE))
      .update(stringToSign, 'utf8')
      .digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Host: host,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      Authorization: authorization,
    };
    if (sessionToken) {
      headers['X-Amz-Security-Token'] = sessionToken;
    }

    const req = https.request({ host, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (ok) {
          logger.info('email.send.ok', { to, subject });
        } else {
          logger.warn('email.send.failed', { status: res.statusCode, body: data });
        }
        resolve({ ok, status: res.statusCode, body: data });
      });
    });
    req.on('error', (err) => {
      logger.warn('email.send.error', { error: err.message });
      resolve({ ok: false, status: 0, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

module.exports = { sendEmail };
