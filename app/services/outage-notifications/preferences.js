/**
 * Per-account notification preferences for the outage notification service.
 *
 * Opt-in is per contact per channel and every channel defaults to off
 * (AC-7, D1). setChannel() writes an audit entry {at, actor, contactId,
 * channel, enabled} and stamps lastChangedAt/lastChangedBy (AC-8). SMS and
 * webhook choices are saved now but not delivered until phase 2 (D3).
 */

const SEED = {
  'acct-lumen-1001': [
    {
      id: 'contact-1001-a',
      name: 'Dana Whitfield',
      firstName: 'Dana',
      role: 'Network Operations Lead',
      email: 'dana.whitfield@northwind-logistics.example',
      timezone: 'America/Los_Angeles',
      channels: { email: true, sms: false, webhook: false },
    },
    {
      id: 'contact-1001-b',
      name: 'Marcus Oyelaran',
      firstName: 'Marcus',
      role: 'SRE Manager',
      email: 'marcus.oyelaran@northwind-logistics.example',
      timezone: 'America/Chicago',
      channels: { email: false, sms: false, webhook: false },
    },
    {
      id: 'contact-1001-c',
      name: 'Priya Raman',
      firstName: 'Priya',
      role: 'IT Director',
      email: 'priya.raman@northwind-logistics.example',
      timezone: 'America/New_York',
      channels: { email: false, sms: false, webhook: false },
    },
  ],
  'acct-lumen-2002': [
    {
      id: 'contact-2002-a',
      name: 'Ellen Marsh',
      firstName: 'Ellen',
      role: 'Infrastructure Analyst',
      email: 'ellen.marsh@contoso-health.example',
      timezone: 'America/Denver',
      channels: { email: true, sms: false, webhook: false },
    },
    {
      id: 'contact-2002-b',
      name: 'Tomas Reyes',
      firstName: 'Tomas',
      role: 'Service Desk Owner',
      email: 'tomas.reyes@contoso-health.example',
      timezone: 'America/Denver',
      channels: { email: false, sms: false, webhook: false },
    },
  ],
};

let store = null;

function seed() {
  store = {};
  for (const [accountId, contacts] of Object.entries(SEED)) {
    store[accountId] = {
      accountId,
      contacts: contacts.map((c) => ({
        ...c,
        channels: { ...c.channels },
        circuits: 'all',
        lastChangedAt: null,
        lastChangedBy: null,
      })),
      audit: [],
    };
  }
}

function ensure() {
  if (!store) seed();
  return store;
}

function getPreferences(accountId) {
  const account = ensure()[accountId];
  if (!account) return null;
  return {
    accountId,
    contacts: account.contacts,
    audit: account.audit,
  };
}

function setChannel({ accountId, contactId, channel, enabled, actor, now }) {
  const account = ensure()[accountId];
  if (!account) return null;
  const contact = account.contacts.find((c) => c.id === contactId);
  if (!contact) return null;
  if (!Object.hasOwn(contact.channels, channel)) return null;

  const at = (now ? new Date(now) : new Date()).toISOString();
  contact.channels[channel] = Boolean(enabled);
  contact.lastChangedAt = at;
  contact.lastChangedBy = actor || 'unknown';
  const entry = {
    at,
    actor: contact.lastChangedBy,
    contactId,
    channel,
    enabled: Boolean(enabled),
  };
  account.audit.push(entry);
  return { contact, audit: entry };
}

function optedInContacts(accountId, channel) {
  const account = ensure()[accountId];
  if (!account) return [];
  return account.contacts.filter((c) => c.channels[channel] === true);
}

function resetPreferences() {
  seed();
}

module.exports = {
  getPreferences,
  setChannel,
  optedInContacts,
  resetPreferences,
};
