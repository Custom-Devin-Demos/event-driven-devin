const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.SLACK_MEMBER_ID_50753C43 || 'U0BU46F4WCU';

const CAMPAIGNS = {
  'COLES15-NEWTOAU': {
    name: 'New to Australia grocery credit',
    productCode: 'everyday_smart_access',
    partner: 'Coles Online',
    creditScheduleId: 'grocery_partner_v2',
    minSpendAud: 50,
    closesOn: '2026-10-27',
    residency: ['new_to_australia', 'temporary_resident'],
  },
  'SAVER10-EVERYDAY': {
    name: 'Everyday account welcome credit',
    productCode: 'everyday_smart_access',
    partner: 'CommBank Rewards',
    creditScheduleId: 'retail_partner_v1',
    minSpendAud: 40,
    closesOn: '2026-12-31',
    residency: ['new_to_australia', 'temporary_resident', 'citizen'],
  },
};

const CREDIT_SCHEDULES = {
  retail_partner_v1: {
    creditAmountAud: 10,
    settlementDays: 14,
    ledgerCode: 'RTL-PARTNER-01',
  },
  grocery_partner_v1: {
    creditAmountAud: 15,
    settlementDays: 10,
    ledgerCode: 'GRC-PARTNER-01',
  },
};

const CHANNEL_LIMITS = {
  online_grocery_partner: { dailyRedemptions: 1, requiresLinkedCard: true },
  branch: { dailyRedemptions: 1, requiresLinkedCard: false },
  app: { dailyRedemptions: 2, requiresLinkedCard: true },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the homepage promotional offer eligibility check:',
  '- Service: `app/services/verticals/50753c43.js`',
  '- Route: `app/routes/verticals/50753c43.js`',
  '- Page: `app/public/verticals/50753c43.html` (served at `/50753c43`)',
  '',
  'The homepage hero CTA calls `POST /api/50753c43/offer-eligibility` and returns a 500.',
  'Preserve the existing behaviour for every campaign that already resolves successfully.',
  'Run `npm run lint` and verify the hero CTA on `/50753c43` returns a confirmed offer.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validateRequest(data) {
  if (!data.campaignCode || !CAMPAIGNS[data.campaignCode]) {
    const error = new Error('That offer is no longer available.');
    error.name = 'ValidationError';
    error.code = 'CAMPAIGN_NOT_FOUND';
    error.statusCode = 400;
    throw error;
  }

  if (!data.channel || !CHANNEL_LIMITS[data.channel]) {
    const error = new Error('Select a valid channel for this offer.');
    error.name = 'ValidationError';
    error.code = 'CHANNEL_INVALID';
    error.statusCode = 400;
    throw error;
  }

  const campaign = CAMPAIGNS[data.campaignCode];
  if (!campaign.residency.includes(data.residencyStatus)) {
    const error = new Error('This offer is not available for your residency status.');
    error.name = 'ValidationError';
    error.code = 'RESIDENCY_NOT_ELIGIBLE';
    error.statusCode = 400;
    throw error;
  }
}

function resolveCreditSchedule(campaign) {
  return CREDIT_SCHEDULES[campaign.creditScheduleId];
}

function buildOfferSummary(offerId, campaign, schedule, data) {
  const limits = CHANNEL_LIMITS[data.channel];

  return {
    success: true,
    offerId,
    offer: {
      campaignCode: data.campaignCode,
      name: campaign.name,
      partner: campaign.partner,
      creditAmount: schedule.creditAmountAud,
      minSpend: campaign.minSpendAud,
      settlementDays: schedule.settlementDays,
      ledgerCode: schedule.ledgerCode,
      closesOn: campaign.closesOn,
      redemptionsPerDay: limits.dailyRedemptions,
      linkedCardRequired: limits.requiresLinkedCard,
    },
  };
}

async function checkOfferEligibility(data) {
  const startTime = Date.now();
  const offerId = `OFR-${uuidv4().slice(0, 8).toUpperCase()}`;

  validateRequest(data);

  const campaign = CAMPAIGNS[data.campaignCode];

  logger.info('Checking homepage offer eligibility', {
    offerId,
    campaignCode: data.campaignCode,
    channel: data.channel,
    service: 'customer-50753c43-offer-eligibility',
    route: '/api/50753c43/offer-eligibility',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 110));

    const schedule = resolveCreditSchedule(campaign);
    const result = buildOfferSummary(offerId, campaign, schedule, data);
    const duration = Date.now() - startTime;

    incrementMetric('offer_eligibility.check_success', {
      route: '/api/50753c43/offer-eligibility',
      campaign: data.campaignCode,
      channel: data.channel,
    });
    recordTiming('offer_eligibility.check_latency', duration, {
      route: '/api/50753c43/offer-eligibility',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('offer_eligibility.check_failure', {
      route: '/api/50753c43/offer-eligibility',
      campaign: data.campaignCode,
      channel: data.channel,
      errorClass: error.name,
    });
    recordTiming('offer_eligibility.check_latency', duration, {
      route: '/api/50753c43/offer-eligibility',
      error: 'true',
    });

    logger.error('Homepage offer eligibility check failed', {
      offerId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      campaignCode: data.campaignCode,
      channel: data.channel,
      service: 'customer-50753c43-offer-eligibility',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/50753c43/offer-eligibility',
        service: 'customer-50753c43-offer-eligibility',
        campaign: data.campaignCode,
        channel: data.channel,
      },
      extra: {
        offerId,
        productCode: campaign.productCode,
        creditScheduleId: campaign.creditScheduleId,
        state: data.state,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/50753c43.js — buildOfferSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-50753c43-offer-eligibility',
      verticalLabel: 'Homepage Offer Eligibility',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '50753c43',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: '/api/50753c43/offer-eligibility' },
        { key: 'service', value: 'customer-50753c43-offer-eligibility' },
        { key: 'campaign', value: data.campaignCode },
        { key: 'channel', value: data.channel },
      ],
      extra: {
        offerId,
        productCode: campaign.productCode,
        creditScheduleId: campaign.creditScheduleId,
        state: data.state,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-50753c43-offer-eligibility@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for offer eligibility error', {
        error: alertError.message,
        offerId,
      });
    });

    throw error;
  }
}

module.exports = {
  checkOfferEligibility,
  resolveCreditSchedule,
  buildOfferSummary,
  CAMPAIGNS,
  CREDIT_SCHEDULES,
  CHANNEL_LIMITS,
  REMEDIATION_DIRECTIVE,
};
