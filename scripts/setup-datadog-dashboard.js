#!/usr/bin/env node

/**
 * Datadog Dashboard Setup Script
 *
 * Creates a pre-built "Acme Commerce - Checkout API" dashboard in Datadog
 * with widgets for request throughput, error rate, p95 latency, and more.
 *
 * Usage:
 *   DD_API_KEY=xxx DD_APP_KEY=xxx DD_SITE=datadoghq.com node scripts/setup-datadog-dashboard.js
 *
 * Requires DD_APP_KEY (application key) in addition to DD_API_KEY.
 * Create an app key at: https://app.datadoghq.com/organization-settings/application-keys
 */

const https = require('https');

const DD_API_KEY = process.env.DD_API_KEY;
const DD_APP_KEY = process.env.DD_APP_KEY;
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';

if (!DD_API_KEY || !DD_APP_KEY) {
  console.error('Error: DD_API_KEY and DD_APP_KEY are required');
  console.error('Set DD_APP_KEY from: https://app.datadoghq.com/organization-settings/application-keys');
  process.exit(1);
}

const dashboard = {
  title: 'Acme Commerce - Checkout API Overview',
  description: 'Demo dashboard for the Acme Commerce checkout-api service. Shows request throughput, error rates, latency, and custom DogStatsD metrics.',
  layout_type: 'ordered',
  widgets: [
    // Row 1: High-level KPIs
    {
      definition: {
        title: 'Service Overview',
        type: 'group',
        layout_type: 'ordered',
        widgets: [
          {
            definition: {
              title: 'Request Throughput (req/s)',
              type: 'timeseries',
              requests: [
                {
                  q: 'sum:trace.express.request.hits{service:checkout-api,env:demo}.as_rate()',
                  display_type: 'bars',
                  style: { palette: 'dog_classic' },
                },
              ],
            },
          },
          {
            definition: {
              title: 'Error Rate (%)',
              type: 'timeseries',
              requests: [
                {
                  q: '100 * sum:trace.express.request.errors{service:checkout-api,env:demo}.as_rate() / sum:trace.express.request.hits{service:checkout-api,env:demo}.as_rate()',
                  display_type: 'line',
                  style: { palette: 'warm' },
                },
              ],
            },
          },
          {
            definition: {
              title: 'p95 Latency (ms)',
              type: 'timeseries',
              requests: [
                {
                  q: 'p95:trace.express.request{service:checkout-api,env:demo}',
                  display_type: 'line',
                  style: { palette: 'purple' },
                },
              ],
            },
          },
        ],
      },
    },
    // Row 2: Checkout-specific metrics
    {
      definition: {
        title: 'Checkout Metrics (DogStatsD)',
        type: 'group',
        layout_type: 'ordered',
        widgets: [
          {
            definition: {
              title: 'Checkout Success vs Failure',
              type: 'timeseries',
              requests: [
                {
                  q: 'sum:demo.checkout.success{*}.as_count()',
                  display_type: 'bars',
                  style: { palette: 'green' },
                },
                {
                  q: 'sum:demo.checkout.failure{*}.as_count()',
                  display_type: 'bars',
                  style: { palette: 'red' },
                },
              ],
            },
          },
          {
            definition: {
              title: 'Checkout Latency (p50 / p95 / p99)',
              type: 'timeseries',
              requests: [
                {
                  q: 'avg:demo.checkout.latency{*}',
                  display_type: 'line',
                  style: { palette: 'cool' },
                },
                {
                  q: 'p95:demo.checkout.latency{*}',
                  display_type: 'line',
                  style: { palette: 'warm' },
                },
              ],
            },
          },
          {
            definition: {
              title: 'Search Requests',
              type: 'timeseries',
              requests: [
                {
                  q: 'sum:demo.search.requests{*}.as_count()',
                  display_type: 'bars',
                  style: { palette: 'dog_classic' },
                },
              ],
            },
          },
        ],
      },
    },
    // Row 3: By version (for release regression story)
    {
      definition: {
        title: 'By Version (Release Impact)',
        type: 'group',
        layout_type: 'ordered',
        widgets: [
          {
            definition: {
              title: 'Error Rate by Version',
              type: 'timeseries',
              requests: [
                {
                  q: 'sum:trace.express.request.errors{service:checkout-api,env:demo} by {version}.as_rate()',
                  display_type: 'line',
                  style: { palette: 'semantic' },
                },
              ],
            },
          },
          {
            definition: {
              title: 'p95 Latency by Version',
              type: 'timeseries',
              requests: [
                {
                  q: 'p95:trace.express.request{service:checkout-api,env:demo} by {version}',
                  display_type: 'line',
                  style: { palette: 'semantic' },
                },
              ],
            },
          },
        ],
      },
    },
    // Row 4: Logs
    {
      definition: {
        title: 'Recent Logs',
        type: 'log_stream',
        query: 'service:checkout-api env:demo',
        columns: ['timestamp', 'level', 'message', 'scenario'],
        message_display: 'inline',
      },
    },
  ],
  template_variables: [
    { name: 'env', default: 'demo', prefix: 'env' },
    { name: 'service', default: 'checkout-api', prefix: 'service' },
    { name: 'version', default: '*', prefix: 'version' },
  ],
};

function createDashboard() {
  const data = JSON.stringify(dashboard);

  const options = {
    hostname: `api.${DD_SITE}`,
    path: '/api/v1/dashboard',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': DD_API_KEY,
      'DD-APPLICATION-KEY': DD_APP_KEY,
      'Content-Length': Buffer.byteLength(data),
    },
  };

  console.log(`Creating Datadog dashboard on ${DD_SITE}...`);

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200 || res.statusCode === 201) {
        const result = JSON.parse(body);
        console.log('Dashboard created successfully!');
        console.log(`  Title: ${result.title}`);
        console.log(`  ID:    ${result.id}`);
        console.log(`  URL:   https://app.${DD_SITE}/dashboard/${result.id}`);
      } else {
        console.error(`Error ${res.statusCode}: ${body}`);
        process.exit(1);
      }
    });
  });

  req.on('error', (error) => {
    console.error('Request failed:', error.message);
    process.exit(1);
  });

  req.write(data);
  req.end();
}

createDashboard();
