const DELIVERY_PROFILES = {
  asap: {
    code: 'asap',
    label: 'Deliver now',
    preparationMinutes: 18,
    transitRangeMinutes: [12, 24],
    charges: [
      { code: 'service', amountCents: 199 },
      { code: 'delivery', amountCents: 349 },
    ],
  },
  scheduled: {
    code: 'scheduled',
    label: 'Schedule for later',
    preparationMinutes: 16,
    transitRangeMinutes: [14, 28],
    charges: [
      { code: 'service', amountCents: 199 },
      { code: 'delivery', amountCents: 249 },
    ],
  },
};

function buildFulfillmentPlan(windowCode, restaurant) {
  const profile = DELIVERY_PROFILES[windowCode] || DELIVERY_PROFILES.asap;
  const [minimumTransitMinutes, maximumTransitMinutes] = profile.transitRangeMinutes;

  return {
    profile: {
      code: profile.code,
      label: profile.label,
      estimates: {
        earliestMinutes: profile.preparationMinutes + minimumTransitMinutes,
        latestMinutes: profile.preparationMinutes + maximumTransitMinutes,
      },
    },
    chargeLines: profile.charges.map((charge) => ({
      type: charge.code,
      amount: {
        currency: 'USD',
        cents: charge.amountCents,
      },
    })),
    merchant: {
      id: restaurant.id,
      name: restaurant.name,
      preparationMinutes: profile.preparationMinutes,
    },
  };
}

module.exports = { buildFulfillmentPlan, DELIVERY_PROFILES };
