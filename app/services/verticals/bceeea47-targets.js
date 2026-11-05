/**
 * Connected systems the leaver-revocation batch de-provisions, and the
 * service-level windows each access tier must be revoked within.
 */
const TARGETS = [
  { id: 'sso', name: 'Workforce SSO (Okta)', kind: 'Identity', regions: ['AMER', 'EMEA', 'APAC', 'JP'], health: 'ok' },
  { id: 'ad', name: 'Active Directory', kind: 'Directory', regions: ['AMER', 'EMEA', 'APAC', 'JP'], health: 'ok' },
  { id: 'vpn', name: 'Remote access VPN', kind: 'Network', regions: ['AMER', 'EMEA', 'APAC', 'JP'], health: 'ok' },
  { id: 'm365', name: 'Microsoft 365 mailbox', kind: 'Collaboration', regions: ['AMER', 'EMEA', 'APAC', 'JP'], health: 'ok' },
  { id: 'dealer-portal', name: 'Dealer network portal', kind: 'Partner access', regions: ['AMER', 'EMEA', 'APAC'], health: 'ok' },
  { id: 'ot-jumphost', name: 'Plant network jump hosts', kind: 'OT access', regions: ['AMER', 'EMEA', 'APAC', 'JP'], health: 'ok', privilegedOnly: true },
  { id: 'scm', name: 'Source control (GitHub Enterprise)', kind: 'Engineering', regions: ['AMER', 'EMEA', 'JP'], health: 'ok' },
];

const SLA_MINUTES = {
  privileged: 60,
  standard: 240,
};

const TARGET_INDEX = TARGETS.reduce((index, target) => {
  index[target.id] = target;
  return index;
}, {});

function resolveTarget(systemId) {
  return TARGET_INDEX[systemId] || null;
}

function slaMinutes(tier) {
  return SLA_MINUTES[tier] || SLA_MINUTES.standard;
}

function baseSteps(target) {
  return [
    { action: 'disable-account', target: target.id },
    { action: 'revoke-sessions', target: target.id },
  ];
}

function revocationSteps(target, leaver) {
  const steps = baseSteps(target);
  if (target.privilegedOnly) {
    return {
      steps: steps.concat([{ action: 'rotate-shared-credentials', target: target.id }]),
      credentialRotation: { scope: leaver.region, reason: `leaver ${leaver.id}` },
    };
  }
  return steps;
}

module.exports = { TARGETS, SLA_MINUTES, resolveTarget, slaMinutes, revocationSteps };
