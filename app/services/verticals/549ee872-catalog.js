/**
 * Account offerings surfaced from the homepage and the fee schedules that
 * price them. Schedules are stored once and referenced by key so a pricing
 * change applies to every offering that shares it.
 */

const FEE_SCHEDULES = Object.freeze({
  'retail-brokerage': {
    label: 'Retail brokerage',
    tiers: [{ upTo: Infinity, accountFee: 0, commissionPerTrade: 0, advisoryBps: 0 }],
  },
  'retirement-ira': {
    label: 'Retirement (IRA)',
    tiers: [{ upTo: Infinity, accountFee: 0, commissionPerTrade: 0, advisoryBps: 0 }],
  },
  'health-savings': {
    label: 'Health savings',
    tiers: [{ upTo: Infinity, accountFee: 0, commissionPerTrade: 0, advisoryBps: 0 }],
  },
  'education-529': {
    label: 'Education savings',
    tiers: [
      { upTo: 25000, accountFee: 0, commissionPerTrade: 0, advisoryBps: 35 },
      { upTo: Infinity, accountFee: 0, commissionPerTrade: 0, advisoryBps: 25 },
    ],
  },
  'managed-wealth': {
    label: 'Wealth management',
    tiers: [
      { upTo: 500000, accountFee: 0, commissionPerTrade: 0, advisoryBps: 110 },
      { upTo: 2000000, accountFee: 0, commissionPerTrade: 0, advisoryBps: 90 },
      { upTo: Infinity, accountFee: 0, commissionPerTrade: 0, advisoryBps: 70 },
    ],
  },
});

const OFFERINGS = Object.freeze([
  {
    code: 'BRK',
    name: 'Brokerage account',
    family: 'investing',
    feeSchedule: 'retail-brokerage',
    minimumDeposit: 0,
    registrations: ['individual', 'joint'],
    fundingMethods: ['eft', 'wire', 'transfer'],
    productPath: '/open-account/brokerage',
  },
  {
    code: 'ROTH',
    name: 'Roth IRA',
    family: 'retirement',
    feeSchedule: 'retirement-ira',
    minimumDeposit: 0,
    registrations: ['individual'],
    fundingMethods: ['eft', 'transfer', 'rollover'],
    productPath: '/retirement-ira/roth-ira',
  },
  {
    code: 'HSA',
    name: 'Health Savings Account',
    family: 'health',
    feeSchedule: 'health-savings',
    minimumDeposit: 0,
    registrations: ['individual'],
    fundingMethods: ['eft', 'payroll', 'transfer'],
    productPath: '/go/hsa/why-hsa',
  },
  {
    code: '529',
    name: '529 college savings plan',
    family: 'education',
    feeSchedule: 'education-529',
    minimumDeposit: 0,
    registrations: ['custodial'],
    fundingMethods: ['eft', 'recurring', 'transfer'],
    productPath: '/529-plans/overview',
  },
  {
    code: 'WLTH',
    name: 'Wealth management',
    family: 'advice',
    feeSchedule: 'managed-wealth',
    minimumDeposit: 500000,
    registrations: ['individual', 'joint', 'trust'],
    fundingMethods: ['wire', 'transfer'],
    productPath: '/wealth-management/overview',
  },
]);

const ENTRY_RULES = [
  [/roth|ira|retire/i, 'ROTH'],
  [/hsa|health/i, 'HSA'],
  [/529|child|education|college/i, '529'],
  [/advisor|wealth|guidance|partner|plan/i, 'WLTH'],
];

function findOffering(code) {
  return OFFERINGS.find((o) => o.code === String(code || '').toUpperCase()) || null;
}

/**
 * Map a homepage selection or entry-point label to an offering. Anything that
 * does not name a specific product opens the default brokerage account.
 */
function resolveOffering(selection, entryPoint) {
  const direct = findOffering(selection);
  if (direct) return direct;
  const label = `${selection || ''} ${entryPoint || ''}`;
  const rule = ENTRY_RULES.find(([pattern]) => pattern.test(label));
  return findOffering(rule ? rule[1] : 'BRK');
}

module.exports = { FEE_SCHEDULES, OFFERINGS, findOffering, resolveOffering };
