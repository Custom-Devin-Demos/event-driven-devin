/**
 * Customer 20c2fe38 — streaming plan catalog.
 *
 * Plans, their billable offers and the billing periods they renew on. Offer
 * periods use ISO 8601 durations, matching the billing provider's price
 * objects.
 */

const PERIODS = Object.freeze({
  P1M: { months: 1, label: 'month' },
  P1Y: { months: 12, label: 'year' },
});

const PLANS = Object.freeze({
  foxone: {
    code: 'foxone',
    name: 'FOX One',
    entitlements: ['fox-sports', 'fox-news', 'fox-entertainment', 'fox-weather', 'fox-business', 'fs1', 'fox-local'],
    offers: [
      { priceId: 'price_1RwPFuDVtWbyvuwDMdbn2lUc', period: 'P1M', amount: 19.99, currency: 'USD', trialDays: 3 },
      { priceId: 'price_1RwPHkDVtWbyvuwDb4cE0aQe', period: 'P1Y', amount: 199.99, currency: 'USD', trialDays: 3 },
    ],
  },
  bundle_onenation: {
    code: 'bundle_onenation',
    name: 'FOX One + FOX Nation',
    entitlements: ['fox-sports', 'fox-news', 'fox-entertainment', 'fox-nation'],
    offers: [
      { priceId: 'price_1S0bNaDVtWbyvuwD7nUq2sKt', period: 'P1M', amount: 24.99, listAmount: 29.98, currency: 'USD', trialDays: 0 },
    ],
  },
  foxone_espn: {
    code: 'foxone_espn',
    name: 'FOX One + ESPN',
    entitlements: ['fox-sports', 'fox-news', 'fox-entertainment', 'espn-unlimited'],
    offers: [
      { priceId: 'price_1SAxPBDVtWbyvuwDoHRMvPDY', period: 'P1M', amount: 39.99, listAmount: 51.98, currency: 'USD', trialDays: 0 },
    ],
  },
  foxnation: {
    code: 'foxnation',
    name: 'FOX Nation',
    entitlements: ['fox-nation'],
    offers: [
      { priceId: 'price_1QmTfZDVtWbyvuwDx2JrLw9h', period: 'P1Y', amount: 64.99, currency: 'USD', trialDays: 0 },
    ],
  },
});

function hasPlan(planCode) {
  return Object.prototype.hasOwnProperty.call(PLANS, planCode);
}

function getPlan(planCode) {
  return PLANS[planCode];
}

function findOffer(planCode, period) {
  return PLANS[planCode].offers.find((offer) => offer.period === period);
}

function periodMonths(period) {
  return PERIODS[period].months;
}

function listPlans() {
  return Object.values(PLANS).map((plan) => ({
    code: plan.code,
    name: plan.name,
    offers: plan.offers.map((offer) => ({
      priceId: offer.priceId,
      period: offer.period,
      amount: offer.amount,
      currency: offer.currency,
    })),
  }));
}

module.exports = {
  PERIODS,
  PLANS,
  hasPlan,
  getPlan,
  findOffer,
  periodMonths,
  listPlans,
};
