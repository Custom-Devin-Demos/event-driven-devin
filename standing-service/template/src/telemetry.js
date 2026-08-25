'use strict';

// dd-trace must be initialized before anything else requires instrumented modules.
if (process.env.DD_AGENT_HOST) {
  // eslint-disable-next-line global-require
  require('dd-trace').init({ logInjection: true });
}

const StatsD = require('hot-shots');

const statsd = new StatsD({
  host: process.env.DD_AGENT_HOST || '127.0.0.1',
  prefix: '',
  errorHandler: () => {},
  mock: !process.env.DD_AGENT_HOST,
});

// Metrics deliberately carry no org tag (cardinality hygiene).
function increment(metric, tags = {}) {
  statsd.increment(metric, 1, tags);
}

function gauge(metric, value, tags = {}) {
  statsd.gauge(metric, value, tags);
}

function log(level, message, fields = {}) {
  const entry = { level, message, timestamp: new Date().toISOString(), ...fields };
  if (fields.error instanceof Error) {
    entry.error = { message: fields.error.message, stack: fields.error.stack };
  }
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

module.exports = { statsd, increment, gauge, log };
