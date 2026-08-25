'use strict';

require('dotenv').config();
require('./telemetry');

const matcher = require('./matcher');
const ingest = require('./ingest');
const executor = require('./executor');
const { createAdminServer } = require('../admin/server');
const { log } = require('./telemetry');

const port = Number(process.env.PORT || 4000);

matcher.start();
ingest.start();
executor.start();

createAdminServer().listen(port, () => {
  log('info', 'automations-service admin API listening', { port });
});
