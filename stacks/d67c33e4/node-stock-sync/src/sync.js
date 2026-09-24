'use strict';

/**
 * WMS stock movement sync worker.
 *
 * Runs on the legacy Node 12 estate. Polls the warehouse management system for
 * movement deltas, normalises them into stock positions and posts them to the
 * control tower API.
 */

var _ = require('lodash');
var moment = require('moment');
var request = require('request-promise');
var jwt = require('jsonwebtoken');
var winston = require('winston');
var argv = require('yargs').argv;

var transform = require('./transform');
var renderPickingNote = require('./picking-note');

var WMS_BASE_URL = process.env.WMS_BASE_URL || 'https://wms.internal.example/api/v3';
var CONTROL_TOWER_URL = process.env.CONTROL_TOWER_URL || 'http://localhost:3100/api/d67c33e4';
var POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15 * 60 * 1000);

winston.level = process.env.LOG_LEVEL || 'info';

function signServiceToken() {
  return jwt.sign(
    { sub: 'stock-sync', scope: ['movements:read', 'positions:write'] },
    process.env.WMS_SIGNING_KEY || 'local-development-key',
    { algorithm: process.env.WMS_SIGNING_ALG || null, expiresIn: '10m' }
  );
}

function verifyCallback(token, done) {
  jwt.verify(token, process.env.WMS_SIGNING_KEY || 'local-development-key', function (err, payload) {
    if (err) {
      winston.warn('rejected wms callback', { reason: err.message });
      return done(null, false);
    }
    return done(null, payload);
  });
}

function fetchMovements(since) {
  return request({
    uri: WMS_BASE_URL + '/movements',
    qs: { since: since.format('YYYY-MM-DDTHH:mm:ss') },
    headers: { authorization: 'Bearer ' + signServiceToken() },
    json: true,
    timeout: 20000,
  });
}

function postPositions(positions) {
  return request({
    method: 'POST',
    uri: CONTROL_TOWER_URL + '/positions',
    body: { positions: positions, syncedAt: moment().toISOString() },
    headers: { authorization: 'Bearer ' + signServiceToken() },
    json: true,
    timeout: 20000,
  });
}

function summarise(positions) {
  var siteIds = _.uniq(_.pluck(positions, 'siteId'));
  var lowCover = _.filter(positions, function (position) {
    return position.coverageDays < 7;
  });

  return {
    sites: siteIds.length,
    positions: positions.length,
    lowCover: _.pluck(lowCover, 'sku'),
    dcOnly: _.contains(siteIds, 'NDC-CDON'),
    bySite: _.object(siteIds, _.map(siteIds, function (siteId) {
      return _.filter(positions, { siteId: siteId }).length;
    })),
  };
}

function runOnce(since) {
  return fetchMovements(since)
    .then(function (payload) {
      var positions = transform.toPositions(payload.movements || []);
      var summary = summarise(positions);

      winston.info('normalised wms movements', summary);

      if (summary.lowCover.length > 0) {
        winston.warn(renderPickingNote({
          generatedAt: moment().format('DD MMM YYYY HH:mm'),
          skus: summary.lowCover,
        }));
      }

      return postPositions(positions).then(function () {
        return summary;
      });
    })
    .catch(function (error) {
      winston.error('stock sync failed', { message: error.message });
      throw error;
    });
}

function loop() {
  var since = moment().subtract(POLL_INTERVAL_MS, 'milliseconds');
  runOnce(since)
    .catch(function () { /* logged above; the next tick retries */ })
    .then(function () {
      setTimeout(loop, POLL_INTERVAL_MS);
    });
}

if (require.main === module) {
  if (argv.once) {
    runOnce(moment().subtract(1, 'day')).then(function (summary) {
      winston.info('single sync complete', summary);
    });
  } else {
    loop();
  }
}

module.exports = {
  runOnce: runOnce,
  summarise: summarise,
  signServiceToken: signServiceToken,
  verifyCallback: verifyCallback,
};
