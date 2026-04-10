const express = require('express');
const logger = require('../telemetry/logger');
const { listEnterpriseOrgs, listOrgUsers } = require('../services/devin-api');

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
/*  POST /api/resolve-identity                                        */
/*  Accepts { orgName, email } and resolves them to Devin IDs         */
/*  server-side. No org/user lists are exposed to the browser.        */
/*  Results are cached for 5 minutes to reduce API calls.             */
/* ------------------------------------------------------------------ */
let cachedOrgs = null;
let orgsCacheExpiry = 0;
const usersCacheByOrg = new Map();

router.post('/api/resolve-identity', async (req, res) => {
  const { orgName, email } = req.body || {};

  if (!orgName && !email) {
    return res.status(400).json({ error: 'orgName or email is required' });
  }

  const result = { orgId: '', userId: '' };

  try {
    // --- Resolve org name → org ID ---
    if (orgName) {
      const now = Date.now();
      if (!cachedOrgs || now >= orgsCacheExpiry) {
        cachedOrgs = await listEnterpriseOrgs();
        orgsCacheExpiry = now + 5 * 60 * 1000;
      }

      const normalizedInput = orgName.trim().toLowerCase();
      const match = cachedOrgs.find(
        (o) => (o.name || '').toLowerCase() === normalizedInput,
      );

      if (match) {
        result.orgId = match.org_id;
      } else {
        logger.warn('Org name not found during identity resolution', { orgName });
        return res.status(404).json({ error: 'Organization not found', field: 'orgName' });
      }
    }

    // --- Resolve email → user ID ---
    if (email && result.orgId) {
      const cacheKey = result.orgId;
      const now = Date.now();
      let users;

      const cached = usersCacheByOrg.get(cacheKey);
      if (cached && now < cached.expiry) {
        users = cached.users;
      } else {
        users = await listOrgUsers(result.orgId);
        usersCacheByOrg.set(cacheKey, { users, expiry: now + 5 * 60 * 1000 });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const userMatch = users.find(
        (u) => (u.email || '').toLowerCase() === normalizedEmail,
      );

      if (userMatch) {
        result.userId = userMatch.user_id;
      } else {
        logger.warn('Email not found during identity resolution', { email, orgId: result.orgId });
        return res.status(404).json({ error: 'User not found in this organization', field: 'email' });
      }
    }

    return res.json(result);
  } catch (err) {
    logger.error('Identity resolution failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to resolve identity', detail: err.message });
  }
});

module.exports = router;
