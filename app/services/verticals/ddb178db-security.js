const STEP_UP_POLICIES = [
  {
    segment: 'preferred-rewards',
    tier: 'gold',
    sessionTtlMinutes: 10,
    otpChannels: ['sms', 'email', 'authenticator'],
    requireOtpOnNewDevice: true,
    transferLimit: 10000,
  },
  {
    segment: 'preferred-rewards',
    tier: 'platinum',
    sessionTtlMinutes: 15,
    otpChannels: ['sms', 'email', 'authenticator', 'ussd-key'],
    requireOtpOnNewDevice: true,
    transferLimit: 25000,
  },
  {
    segment: 'core',
    tier: 'standard',
    sessionTtlMinutes: 10,
    otpChannels: ['sms', 'email'],
    requireOtpOnNewDevice: true,
    transferLimit: 3500,
  },
];

const DEVICE_TRUST_RULES = {
  gold: { rememberDays: 90, maxTrustedDevices: 5 },
  platinum: { rememberDays: 180, maxTrustedDevices: 8 },
  standard: { rememberDays: 30, maxTrustedDevices: 3 },
};

const policyKey = (segment, tier) => `${segment}/${tier}`;

const POLICY_INDEX = new Map(STEP_UP_POLICIES.map((p) => [policyKey(p.segment, p.tier), p]));

function stepUpPolicyFor(profile) {
  return POLICY_INDEX.get(policyKey(profile.enrollment.segment, profile.enrollment.tier));
}

function deviceTrustRulesFor(profile) {
  return DEVICE_TRUST_RULES[profile.enrollment.tier];
}

module.exports = { STEP_UP_POLICIES, stepUpPolicyFor, deviceTrustRulesFor };
