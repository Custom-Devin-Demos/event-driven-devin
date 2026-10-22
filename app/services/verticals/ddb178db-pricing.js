const PRICING_SCHEDULES = [
  {
    network: 'visa',
    tier: 'signature',
    purchaseApr: { min: 18.24, max: 28.24 },
    introPurchaseCycles: 15,
    balanceTransferFee: '3% of each transaction (min $10)',
    foreignTransactionFee: 3,
    cashAdvanceApr: 29.24,
  },
  {
    network: 'visa',
    tier: 'platinum plus',
    purchaseApr: { min: 15.24, max: 25.24 },
    introPurchaseCycles: 21,
    balanceTransferFee: '3% of each transaction (min $10)',
    foreignTransactionFee: 3,
    cashAdvanceApr: 29.24,
  },
  {
    network: 'mastercard',
    tier: 'world',
    purchaseApr: { min: 18.24, max: 28.24 },
    introPurchaseCycles: 0,
    balanceTransferFee: '3% of each transaction (min $10)',
    foreignTransactionFee: 0,
    cashAdvanceApr: 29.24,
  },
];

const DISCLOSURE_TEMPLATES = {
  signature: 'The {{name}} Visa Signature® card has a variable purchase APR of {{apr}} based on your creditworthiness. {{intro}}',
  'platinum plus': 'The {{name}} Platinum Plus® Mastercard® card has a variable purchase APR of {{apr}} based on your creditworthiness. {{intro}}',
  world: 'The {{name}} World Mastercard® card has a variable purchase APR of {{apr}} based on your creditworthiness. {{intro}}',
};

const scheduleKey = (network, tier) => `${network}/${tier}`;

const SCHEDULE_INDEX = new Map(PRICING_SCHEDULES.map((s) => [scheduleKey(s.network, s.tier), s]));

function pricingFor(product) {
  return SCHEDULE_INDEX.get(scheduleKey(product.network, product.tier));
}

function disclosureFor(product) {
  return DISCLOSURE_TEMPLATES[product.tier];
}

module.exports = { PRICING_SCHEDULES, pricingFor, disclosureFor };
