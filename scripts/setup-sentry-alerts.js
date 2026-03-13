#!/usr/bin/env node

/**
 * Sentry Alerts & Dashboard Setup Guide
 *
 * Sentry doesn't have a public dashboard creation API, so this script
 * documents the recommended Sentry setup and creates alert rules via the API.
 *
 * Usage:
 *   SENTRY_AUTH_TOKEN=xxx SENTRY_ORG=xxx SENTRY_PROJECT=xxx node scripts/setup-sentry-alerts.js
 *
 * Create an auth token at: https://sentry.io/settings/auth-tokens/
 * Required scopes: project:read, alerts:write
 *
 * ─── Manual Dashboard Setup (Sentry UI) ───────────────────────────
 *
 * Go to Sentry > Dashboards > Create Dashboard and add these widgets:
 *
 * 1. "Issues by Release"
 *    - Widget type: Table
 *    - Query: is:unresolved
 *    - Group by: release
 *    - Sort: count() desc
 *
 * 2. "Error Trend (24h)"
 *    - Widget type: Line chart
 *    - Query: event.type:error
 *    - Y-axis: count()
 *    - Interval: 1 hour
 *
 * 3. "Checkout API Traces"
 *    - Widget type: Line chart
 *    - Query: transaction:/checkout
 *    - Y-axis: p95(transaction.duration)
 *
 * 4. "Top Failing Endpoints"
 *    - Widget type: Table
 *    - Query: event.type:error
 *    - Group by: transaction
 *    - Sort: count() desc
 *
 * 5. "Latest Regressions"
 *    - Widget type: Table
 *    - Query: is:unresolved is:regression
 *    - Columns: title, count(), lastSeen, release
 *
 * ───────────────────────────────────────────────────────────────────
 */

const https = require('https');

const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG = process.env.SENTRY_ORG;
const SENTRY_PROJECT = process.env.SENTRY_PROJECT;

if (!SENTRY_AUTH_TOKEN || !SENTRY_ORG || !SENTRY_PROJECT) {
  console.error('Error: SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT are required');
  console.error('Create a token at: https://sentry.io/settings/auth-tokens/');
  console.log('\nNote: Dashboard creation must be done manually in the Sentry UI.');
  console.log('See the comments in this script for the recommended dashboard widgets.');
  process.exit(1);
}

const alerts = [
  {
    name: '[Acme Demo] Checkout Error Spike',
    conditions: [
      {
        id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
        value: 5,
        interval: '5m',
      },
    ],
    actions: [
      {
        id: 'sentry.rules.actions.notify_event.NotifyEventAction',
      },
    ],
    actionMatch: 'all',
    filterMatch: 'all',
    filters: [
      {
        id: 'sentry.rules.filters.tagged_event.TaggedEventFilter',
        key: 'scenario',
        match: 'eq',
        value: 'checkout-regression',
      },
    ],
    frequency: 5,
    environment: 'demo',
  },
  {
    name: '[Acme Demo] New Issue on Release',
    conditions: [
      {
        id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition',
      },
    ],
    actions: [
      {
        id: 'sentry.rules.actions.notify_event.NotifyEventAction',
      },
    ],
    actionMatch: 'all',
    filterMatch: 'all',
    filters: [],
    frequency: 5,
    environment: 'demo',
  },
  {
    name: '[Acme Demo] Regression Detected',
    conditions: [
      {
        id: 'sentry.rules.conditions.regression_event.RegressionEventCondition',
      },
    ],
    actions: [
      {
        id: 'sentry.rules.actions.notify_event.NotifyEventAction',
      },
    ],
    actionMatch: 'all',
    filterMatch: 'all',
    filters: [],
    frequency: 5,
    environment: 'demo',
  },
];

function createAlert(alert) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(alert);

    const options = {
      hostname: 'sentry.io',
      path: `/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/rules/`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SENTRY_AUTH_TOKEN}`,
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          const result = JSON.parse(body);
          console.log(`  Created alert: "${result.name}" (ID: ${result.id})`);
          resolve(result);
        } else {
          console.error(`  Error ${res.statusCode} creating "${alert.name}": ${body}`);
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log(`Setting up Sentry alerts for ${SENTRY_ORG}/${SENTRY_PROJECT}...\n`);

  for (const alert of alerts) {
    try {
      await createAlert(alert);
    } catch (error) {
      console.error(`  Failed: ${error.message}`);
    }
  }

  console.log('\nAlert setup complete.');
  console.log('\nReminder: Create the dashboard manually in Sentry UI.');
  console.log('See the comments at the top of this script for recommended widgets.');
}

main().catch((error) => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
