'use strict';

const { getDb } = require('../db');
const providerA = require('./provider-a');
const providerB = require('./provider-b');

// storage_cloud_provider_configs (prod Postgres) selects the provider client
// per org. Orgs without a row default to provider A.

const PROVIDERS = {
  'provider-a': providerA,
  'provider-b': providerB,
};

async function clientForOrg(session, orgId) {
  const db = getDb();
  const result = await db.query(
    'SELECT provider, config FROM storage_cloud_provider_configs WHERE org_id = $1',
    [orgId],
  );
  const provider = result.rows.length > 0 ? result.rows[0].provider : 'provider-a';
  const factory = PROVIDERS[provider];
  if (!factory) throw new Error(`Unknown storage provider: ${provider}`);
  return factory.createClient(result.rows[0]?.config || {});
}

// Container names are derived from the org slug and the payload subpath.
function containerName(orgId, subpath) {
  return `${orgId}-${subpath}`.toLowerCase();
}

module.exports = { clientForOrg, containerName };
