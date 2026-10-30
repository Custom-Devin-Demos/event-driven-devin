const { randomUUID } = require('crypto');
const { Sentry } = require('../../telemetry/sentry');
const logger = require('../../telemetry/logger');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'membership-signup-svc';
const ROUTE = '/api/ca610f30/memberships';
const PLANS = {
  standard_ads_2025: { name: 'Standard with ads', monthlyPrice: 8.99 },
  standard_2025: { name: 'Standard', monthlyPrice: 19.99 },
  premium_uhd_2026: { name: 'Premium', monthlyPrice: 26.99 },
};

// Playback Licensing owns this table. Growth/Billing shipped the 2026 Premium
// UHD SKU rename independently of the playback entitlement release.
const PLAYBACK_ENTITLEMENTS = {
  standard_ads_2025: { maxConcurrentStreams: 2, resolution: '1080p', ads: true },
  standard_2025: { maxConcurrentStreams: 2, resolution: '1080p', ads: false },
  premium_2025: { maxConcurrentStreams: 4, resolution: '4K + HDR', ads: false },
};

function resolvePlaybackEntitlement(planSku) {
  return PLAYBACK_ENTITLEMENTS[planSku];
}

function provisionStreamEntitlement(membershipId, entitlement) {
  return {
    membershipId,
    maxConcurrentStreams: entitlement.maxConcurrentStreams,
    resolution: entitlement.resolution,
  };
}

async function startMembership(data) {
  const membershipId = `NFX-${randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    const entitlement = resolvePlaybackEntitlement(data.planSku);
    const playback = provisionStreamEntitlement(membershipId, entitlement);
    return { success: true, membershipId, plan: PLANS[data.planSku].name, playback };
  } catch (error) {
    const extra = { membershipId, planSku: data.planSku };
    logger.error('Netflix membership provisioning failed', { ...extra, error: error.message });
    Sentry.captureException(error, {
      tags: { service: SERVICE, route: ROUTE, team: 'nflx-growth' },
      extra,
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ca610f30.js — provisionStreamEntitlement',
      errorType: error.name,
      errorValue: error.message,
      customer: 'ca610f30',
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: SERVICE,
      verticalLabel: 'Netflix — Membership Signup',
      ticketPrefix: 'NFX',
      tags: [{ key: 'route', value: ROUTE }, { key: 'service', value: SERVICE }, { key: 'team', value: 'nflx-growth' }],
      extra,
      level: 'error',
      platform: 'node',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.1`,
      environment: process.env.DD_ENV || 'prod',
      lastSeen: new Date().toISOString(),
    }).catch((err) => logger.error('Netflix membership alert failed', { error: err.message }));
    throw error;
  }
}

module.exports = { startMembership, PLANS, PLAYBACK_ENTITLEMENTS, resolvePlaybackEntitlement, provisionStreamEntitlement };
