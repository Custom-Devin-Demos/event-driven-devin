'use strict';

const crypto = require('crypto');
const express = require('express');
const demo = require('./demo');
const vpc = require('./vpc');
const { recordHeartbeat } = require('../src/runtime-stats');
const { log } = require('../src/telemetry');

function tokenMatches(presented, configured) {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdminToken(req, res, next) {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) {
    return res.status(503).json({ error: 'ADMIN_TOKEN is not configured' });
  }
  const header = req.headers.authorization || '';
  const presented = header.replace(/^Bearer\s+/i, '');
  if (!tokenMatches(presented, configured)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return next();
}

function createAdminServer() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      log('info', 'http', {
        m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - started,
      });
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Loopback-only: the emitter process reports liveness here.
  app.post('/internal/heartbeat', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    recordHeartbeat();
    return res.json({ ok: true });
  });

  app.post('/admin/demo/arm', requireAdminToken, demo.arm);
  app.post('/admin/demo/disarm', requireAdminToken, demo.disarm);
  app.get('/admin/demo/status', requireAdminToken, demo.status);
  app.post('/admin/vpc/create', requireAdminToken, vpc.create);

  return app;
}

module.exports = { createAdminServer, tokenMatches };
