'use strict';

const { getDb } = require('../src/db');

// Provision a dedicated VPC deployment for a customer. One deployment per
// customer: a second create attempt returns 409.

async function create(req, res) {
  const { customer, require_infra_manage: requireInfraManage } = req.body || {};
  if (!requireInfraManage) {
    return res.status(403).json({ error: 'require_infra_manage capability is required' });
  }
  if (!customer || typeof customer !== 'string') {
    return res.status(400).json({ error: 'customer is required' });
  }
  const db = getDb();
  const existing = await db.query(
    'SELECT id FROM vpc_deployments WHERE org_id = $1',
    [customer],
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: `Deployment already exists for ${customer}` });
  }
  const result = await db.query(
    'INSERT INTO vpc_deployments (org_id) VALUES ($1) RETURNING id, created_at',
    [customer],
  );
  return res.status(201).json({
    id: result.rows[0].id,
    org_id: customer,
    created_at: result.rows[0].created_at,
  });
}

module.exports = { create };
