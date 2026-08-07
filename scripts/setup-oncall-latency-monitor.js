#!/usr/bin/env node

/**
 * Creates the live Datadog metric monitor backing the "DB Latency Spike"
 * on-call story. The monitor watches the checkout.latency statsd timing and
 * genuinely fires while the db-latency degradation window is active.
 *
 * Usage:
 *   DD_API_KEY=xxx DD_APP_KEY=xxx DD_SITE=us5.datadoghq.com node scripts/setup-oncall-latency-monitor.js
 *
 * Idempotent: if a monitor with the same name already exists, it is updated.
 */

const https = require('https');

const DD_API_KEY = process.env.DD_API_KEY;
const DD_APP_KEY = process.env.DD_APP_KEY || process.env.DD_INCIDENT_APP_KEY || process.env.DD_APPLICATION_KEY;
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';

if (!DD_API_KEY || !DD_APP_KEY) {
  console.error('Error: DD_API_KEY and DD_APP_KEY are required');
  process.exit(1);
}

const MONITOR_NAME = 'checkout-api — p95 request latency high (db-latency)';

const monitor = {
  name: MONITOR_NAME,
  type: 'metric alert',
  query: 'avg(last_5m):avg:checkout.latency.avg{*} > 1200',
  message: [
    'p95/avg checkout latency on checkout-api is above 1.2s for 5 minutes.',
    'Symptoms: storefront search and checkout slow to 1.5\u20133s; no elevated error rate.',
    'Runbook: check slow-query warnings in checkout-api logs.',
  ].join('\n'),
  tags: ['service:checkout-api', 'team:oncall-demo', 'story:db-latency'],
  options: {
    thresholds: { critical: 1200, warning: 800 },
    notify_no_data: false,
    renotify_interval: 0,
  },
};

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: `api.${DD_SITE}`,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': DD_API_KEY,
        'DD-APPLICATION-KEY': DD_APP_KEY,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Datadog API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const existing = await request('GET', `/api/v1/monitor?name=${encodeURIComponent(MONITOR_NAME)}`);
  const match = Array.isArray(existing) && existing.find((m) => m.name === MONITOR_NAME);
  if (match) {
    const updated = await request('PUT', `/api/v1/monitor/${match.id}`, monitor);
    console.log(`Updated monitor ${updated.id}: ${updated.name}`);
  } else {
    const created = await request('POST', '/api/v1/monitor', monitor);
    console.log(`Created monitor ${created.id}: ${created.name}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
