'use strict';

require('dotenv').config();

// Provision a customer on their preferred storage provider and (optionally)
// a dedicated VPC deployment via the admin API.
//
// Usage: node scripts/provision-customer.js <ORG_ID> <provider-a|provider-b> [--vpc]

const { Pool } = require('pg');

async function main() {
  const [orgId, provider, vpcFlag] = process.argv.slice(2);
  if (!orgId || !['provider-a', 'provider-b'].includes(provider)) {
    process.stderr.write('usage: provision-customer.js <ORG_ID> <provider-a|provider-b> [--vpc]\n');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    `INSERT INTO storage_cloud_provider_configs (org_id, provider)
     VALUES ($1, $2)
     ON CONFLICT (org_id) DO UPDATE SET provider = EXCLUDED.provider`,
    [orgId, provider],
  );
  await pool.query(
    `INSERT INTO automation_triggers (org_id, source, interval_s, enabled)
     SELECT $1, 'schedule:recurring', 300, false
     WHERE NOT EXISTS (
       SELECT 1 FROM automation_triggers WHERE org_id = $1 AND source = 'schedule:recurring'
     )`,
    [orgId],
  );
  if (vpcFlag === '--vpc') {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 4000}/admin/vpc/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ customer: orgId, require_infra_manage: true }),
    });
    process.stdout.write(`vpc create: ${response.status}\n`);
  }
  await pool.end();
  process.stdout.write(`provisioned ${orgId} on ${provider}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
