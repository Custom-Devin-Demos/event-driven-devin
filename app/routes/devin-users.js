const express = require('express');
const { listEnterpriseOrgs, listOrgUsers } = require('../services/devin-api');

const router = express.Router();

/* ------------------------------------------------------------------ */
/*  GET /api/devin/orgs                                               */
/*  Returns the list of organizations in the enterprise.              */
/*  Results are cached for 5 minutes.                                 */
/* ------------------------------------------------------------------ */
let cachedOrgs = null;
let orgsCacheExpiry = 0;

router.get('/api/devin/orgs', async (_req, res) => {
  try {
    const now = Date.now();
    if (cachedOrgs && now < orgsCacheExpiry) {
      return res.json({ orgs: cachedOrgs });
    }

    const orgs = await listEnterpriseOrgs();
    cachedOrgs = orgs;
    orgsCacheExpiry = now + 5 * 60 * 1000;

    return res.json({ orgs });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch orgs', detail: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/devin/users?orgId=<org_id>                               */
/*  Returns users for the given org (or default org from env).        */
/*  Results are cached per-org for 5 minutes.                         */
/* ------------------------------------------------------------------ */
const usersCacheByOrg = new Map();

router.get('/api/devin/users', async (req, res) => {
  try {
    const orgId = req.query.orgId || '';
    const cacheKey = orgId || '__default__';
    const now = Date.now();

    const cached = usersCacheByOrg.get(cacheKey);
    if (cached && now < cached.expiry) {
      return res.json({ users: cached.users });
    }

    const users = await listOrgUsers(orgId || undefined);
    usersCacheByOrg.set(cacheKey, { users, expiry: now + 5 * 60 * 1000 });

    return res.json({ users });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users', detail: err.message });
  }
});

module.exports = router;
