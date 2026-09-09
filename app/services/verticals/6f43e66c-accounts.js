/**
 * Eligible funding accounts and Zelle® send-limit profiles for the consumer
 * Zelle vertical (6f43e66c).
 *
 * Send limits are governed per account by the Preferred Rewards tier the
 * account is enrolled in. The FY26 limits refresh moved the per-account limit
 * settings under `limits` so that daily and 30-day caps can be overridden
 * per account without cloning a whole profile.
 */
const FUNDING_ACCOUNTS = [
  {
    id: 'adv-plus-chk-4417',
    productLabel: 'Advantage Plus Banking',
    last4: '4417',
    availableBalance: 4832.19,
    limits: { profile: 'preferred-rewards-gold' },
  },
  {
    id: 'adv-relationship-chk-8820',
    productLabel: 'Advantage Relationship Banking',
    last4: '8820',
    availableBalance: 18240.55,
    limits: { profile: 'preferred-rewards-platinum' },
  },
  {
    id: 'adv-savings-2043',
    productLabel: 'Advantage Savings',
    last4: '2043',
    availableBalance: 26115.0,
    limits: { profile: 'consumer-standard' },
  },
];

/**
 * Zelle® send-limit profiles. Caps are in USD.
 */
const LIMIT_PROFILES = {
  'consumer-standard': {
    label: 'Standard',
    perTransactionCap: 3500,
    dailyCap: 3500,
    rollingThirtyDayCap: 20000,
  },
  'preferred-rewards-gold': {
    label: 'Preferred Rewards Gold',
    perTransactionCap: 5000,
    dailyCap: 5000,
    rollingThirtyDayCap: 25000,
  },
  'preferred-rewards-platinum': {
    label: 'Preferred Rewards Platinum',
    perTransactionCap: 7500,
    dailyCap: 7500,
    rollingThirtyDayCap: 40000,
  },
};

/**
 * Enrolled Zelle® recipients (the contacts shown with the purple "Z").
 * Tokens are the U.S. mobile number or email the recipient enrolled with.
 */
const RECIPIENTS = [
  { id: 'rcp-robert', name: 'Robert Thompson', token: 'robert.thompson@gmail.com', tokenType: 'email' },
  { id: 'rcp-maria', name: 'Maria Alvarez', token: '(704) 555-0138', tokenType: 'mobile' },
  { id: 'rcp-james', name: 'James Okafor', token: 'james.okafor@outlook.com', tokenType: 'email' },
  { id: 'rcp-priya', name: 'Priya Natarajan', token: '(980) 555-0192', tokenType: 'mobile' },
];

function findFundingAccount(accountId) {
  return FUNDING_ACCOUNTS.find((account) => account.id === accountId);
}

function findRecipient(recipientId) {
  return RECIPIENTS.find((recipient) => recipient.id === recipientId);
}

module.exports = {
  FUNDING_ACCOUNTS,
  LIMIT_PROFILES,
  RECIPIENTS,
  findFundingAccount,
  findRecipient,
};
