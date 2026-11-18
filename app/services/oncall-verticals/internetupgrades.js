const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { tracer, incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const SERVICE = 'broadband-plan-change-api';
const ROUTE = '/api/oncall/internetupgrades/orders';
const RELEASE = 'plan-change@2026.11.4';

/**
 * Residential internet accounts that can change plans from My Account.
 */
const ACCOUNTS = new Map([
  ['8495-1120-0418', { holder: 'Jordan Rivera', serviceAddress: '1701 JFK Blvd, Apt 2204, Philadelphia, PA 19103', gateway: 'XB8', currentOffer: 'XF-INT-GIG' }],
  ['8495-1120-0733', { holder: 'Avery Chen', serviceAddress: '410 Market St, Unit 6, Philadelphia, PA 19106', gateway: 'XB7', currentOffer: 'XF-INT-500' }],
]);

/**
 * Internet offers as published by offer catalog v2. `speedTier` is the v2
 * DOCSIS speed-tier code.
 */
const OFFER_CATALOG = new Map([
  ['XF-INT-500', { name: '500 Mbps', speedTier: 'D31.RES.0500', monthly: 55 }],
  ['XF-INT-GIG', { name: 'Gigabit', speedTier: 'D31.RES.1000', monthly: 70 }],
  ['XF-INT-GIGX', { name: 'Gigabit Extra', speedTier: 'D31.RES.1200', monthly: 85 }],
  ['XF-INT-GIGX2', { name: 'Gigabit x2', speedTier: 'D40.RES.2000', monthly: 100 }],
]);

/**
 * Modem provisioning profiles applied to the gateway for each speed tier.
 */
const PROVISIONING_PROFILES = {
  RES_500: { bootFile: 'res_d31_500x20.cm', downstreamMbps: 500, upstreamMbps: 20 },
  RES_1000: { bootFile: 'res_d31_1000x35.cm', downstreamMbps: 1000, upstreamMbps: 35 },
  RES_1200: { bootFile: 'res_d31_1200x35.cm', downstreamMbps: 1200, upstreamMbps: 35 },
  RES_2000: { bootFile: 'res_d40_2000x200.cm', downstreamMbps: 2000, upstreamMbps: 200 },
};

function rejectChange(message) {
  return Object.assign(new Error(message), { code: 'INVALID_PLAN_CHANGE' });
}

function validateChange(change = {}) {
  const accountNumber = typeof change.accountNumber === 'string' ? change.accountNumber : '';
  const offerId = typeof change.offerId === 'string' ? change.offerId : '';
  const account = ACCOUNTS.get(accountNumber);
  const offer = OFFER_CATALOG.get(offerId);
  const effective = change.effective === 'next_bill' ? 'next_bill' : change.effective === 'now' ? 'now' : null;
  if (!account) throw rejectChange('We couldn\u2019t find that account.');
  if (!offer) throw rejectChange('Choose an available internet plan.');
  if (offerId === account.currentOffer) throw rejectChange(`You already have ${offer.name}.`);
  if (!effective) throw rejectChange('Choose when the new plan should start.');
  if (change.termsAccepted !== true) throw rejectChange('Accept the plan terms to continue.');
  return { accountNumber, account, offerId, offer, effective };
}

function provisioningKeyFor(offer) {
  return offer.speedTier;
}

function buildModemConfig(change) {
  const profile = PROVISIONING_PROFILES[provisioningKeyFor(change.offer)];
  return {
    gateway: change.account.gateway,
    bootFile: profile.bootFile,
    downstreamMbps: profile.downstreamMbps,
    upstreamMbps: profile.upstreamMbps,
  };
}

/**
 * Apply an internet plan change and queue the gateway reprovision.
 */
async function changePlan(data) {
  const change = validateChange(data);
  const orderId = uuidv4();
  const started = Date.now();
  const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
  return tracer.trace('broadband.plan_change.submit', { service: SERVICE, resource: `POST ${ROUTE}`, tags }, async () => {
    try {
      const modem = buildModemConfig(change);
      incrementMetric('broadband.plan_change.success', tags);
      recordTiming('broadband.plan_change.latency', Date.now() - started, tags);
      logger.info('Internet plan change applied', { ...tags, orderId, accountNumber: change.accountNumber, offerId: change.offerId });
      return {
        success: true,
        orderId,
        status: 'SCHEDULED',
        confirmation: `XF-${orderId.slice(0, 8).toUpperCase()}`,
        accountNumber: change.accountNumber,
        offerId: change.offerId,
        plan: change.offer.name,
        monthly: change.offer.monthly,
        effective: change.effective,
        downstreamMbps: modem.downstreamMbps,
        upstreamMbps: modem.upstreamMbps,
        gateway: modem.gateway,
        scheduledAt: new Date().toISOString(),
      };
    } catch (error) {
      incrementMetric('broadband.plan_change.failure', { ...tags, errorClass: error.name });
      recordTiming('broadband.plan_change.latency', Date.now() - started, { ...tags, error: 'true' });
      logger.error('Internet plan change failed', {
        ...tags, orderId, accountNumber: change.accountNumber, offerId: change.offerId,
        error: error.message, errorClass: error.name, stack: error.stack,
      });
      Sentry.captureException(error, { tags, extra: { orderId, accountNumber: change.accountNumber, offerId: change.offerId } });
      throw error;
    }
  });
}

module.exports = { ACCOUNTS, OFFER_CATALOG, changePlan };
