const express = require('express');
const { listEnterpriseOrgs, listOrgUsers, listEnterpriseAdmins } = require('../services/devin-api');

const router = express.Router();

/* ------------------------------------------------------------------ */
/*  GET /api/config                                                   */
/*  Returns non-secret client configuration for the frontend.         */
/*  Tells the UI whether org/user selection is locked.                 */
/* ------------------------------------------------------------------ */
router.get('/api/config', (_req, res) => {
  const lockOrg = !!process.env.LOCK_ORG;
  const lockUser = !!process.env.DEVIN_USER_ID;
  res.json({
    defaultOrgId: process.env.DEVIN_ORG_ID || '',
    defaultOrgName: process.env.DEVIN_ORG_NAME || '',
    defaultUserId: process.env.DEVIN_USER_ID || '',
    lockOrg,
    lockUser,
    githubOrg: process.env.GITHUB_ORG || 'COG-GTM',
    appTitle: process.env.APP_TITLE || 'Event-Driven Devin',
  });
});

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

    // Fetch org members and enterprise admins in parallel, then merge
    const [orgUsers, admins] = await Promise.all([
      listOrgUsers(orgId || undefined),
      listEnterpriseAdmins(),
    ]);

    // Build a map keyed by user_id so enterprise admins that are already
    // org members appear only once (with the admin flag attached).
    const userMap = new Map();
    orgUsers.forEach((u) => {
      userMap.set(u.user_id, { ...u, is_enterprise_admin: false });
    });
    admins.forEach((a) => {
      if (userMap.has(a.user_id)) {
        // User is already an org member — just flag them as an admin
        userMap.get(a.user_id).is_enterprise_admin = true;
      } else {
        userMap.set(a.user_id, { ...a, is_enterprise_admin: true });
      }
    });

    const users = Array.from(userMap.values());
    usersCacheByOrg.set(cacheKey, { users, expiry: now + 5 * 60 * 1000 });

    return res.json({ users });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users', detail: err.message });
  }
});

module.exports = router;
