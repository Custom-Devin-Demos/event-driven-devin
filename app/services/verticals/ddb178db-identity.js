const PROFILES = [
  {
    onlineId: 'jane.doe',
    customerId: 'CST-4471902',
    firstName: 'Jane',
    enrollment: { segment: 'Preferred Rewards', tier: 'Gold' },
    homeRegion: 'US-Northeast',
    devices: [{ deviceId: 'dev-7f3a', label: 'Chrome on Windows', trusted: true }],
    accounts: ['Advantage Plus Banking', 'Advantage Savings', 'Customized Cash Rewards'],
  },
  {
    onlineId: 'marcus.lee',
    customerId: 'CST-1193377',
    firstName: 'Marcus',
    enrollment: { segment: 'Preferred Rewards', tier: 'Platinum' },
    homeRegion: 'US-West',
    devices: [{ deviceId: 'dev-c21e', label: 'Safari on macOS', trusted: true }],
    accounts: ['Advantage Relationship Banking', 'Merrill Edge Self-Directed'],
  },
  {
    onlineId: 'priya.n',
    customerId: 'CST-8820014',
    firstName: 'Priya',
    enrollment: { segment: 'Core', tier: 'Standard' },
    homeRegion: 'US-Southeast',
    devices: [],
    accounts: ['Advantage SafeBalance Banking'],
  },
];

const DEFAULT_PROFILE = PROFILES[0];

function normalizeOnlineId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function authenticate(onlineId) {
  const id = normalizeOnlineId(onlineId);
  const profile = PROFILES.find((p) => p.onlineId === id) || DEFAULT_PROFILE;
  return { ...profile, enteredId: id || profile.onlineId };
}

module.exports = { PROFILES, authenticate, normalizeOnlineId };
