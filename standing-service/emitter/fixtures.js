'use strict';

// Customer fixtures for the standing automations-service load generator.
// CUST_1 is the poisoned enterprise: provider B + a recurring automation
// whose ingest writes hit an underscore container name. CUST_2 is the trap:
// also on provider B, but its flows never touch the underscore subpath, so
// "it's provider B" is a wrong root cause an investigator must rule out.

const ENTERPRISES = [
  { orgId: 'CUST_1', name: 'Northwind Logistics', provider: 'provider-b', recurring: true, benignRatePerMin: 4 },
  { orgId: 'CUST_2', name: 'Fabrikam Retail', provider: 'provider-b', recurring: false, benignRatePerMin: 5 },
  { orgId: 'CUST_3', name: 'Contoso Energy', provider: 'provider-a', recurring: true, benignRatePerMin: 6 },
  { orgId: 'CUST_4', name: 'Adventure Freight', provider: 'provider-a', recurring: true, benignRatePerMin: 3 },
  { orgId: 'CUST_5', name: 'Tailspin Media', provider: 'provider-a', recurring: false, benignRatePerMin: 4 },
  { orgId: 'CUST_6', name: 'Wingtip Financial', provider: 'provider-a', recurring: true, benignRatePerMin: 5 },
  { orgId: 'CUST_7', name: 'Proseware Health', provider: 'provider-a', recurring: true, benignRatePerMin: 2 },
  { orgId: 'CUST_8', name: 'Litware Manufacturing', provider: 'provider-a', recurring: false, benignRatePerMin: 3 },
  { orgId: 'CUST_9', name: 'Woodgrove Bank', provider: 'provider-a', recurring: true, benignRatePerMin: 6 },
  { orgId: 'CUST_10', name: 'Lamna Insurance', provider: 'provider-a', recurring: true, benignRatePerMin: 2 },
  { orgId: 'CUST_11', name: 'VanArsdel Telecom', provider: 'provider-a', recurring: false, benignRatePerMin: 4 },
  { orgId: 'CUST_12', name: 'Coho Winery Group', provider: 'provider-a', recurring: true, benignRatePerMin: 2 },
  { orgId: 'CUST_13', name: 'Relecloud SaaS', provider: 'provider-a', recurring: true, benignRatePerMin: 5 },
  // Bellows sits behind a flaky corporate proxy: its benign writes hit
  // transient timeouts that succeed on retry. A second failing tenant an
  // investigator must rule out before pinning everything on one customer.
  { orgId: 'CUST_14', name: 'Bellows Aerospace', provider: 'provider-a', recurring: false, benignRatePerMin: 3, transientFailureRate: 0.12 },
  { orgId: 'CUST_15', name: 'Margie Travel', provider: 'provider-a', recurring: true, benignRatePerMin: 2 },
];

const LONG_TAIL_COUNT = 570;

function longTailOrgs() {
  const orgs = [];
  for (let i = 1; i <= LONG_TAIL_COUNT; i += 1) {
    orgs.push({
      orgId: `org-${String(i).padStart(4, '0')}`,
      provider: 'provider-a',
      recurring: i % 3 === 0,
      benignRatePerMin: 0.05,
    });
  }
  return orgs;
}

// Benign IndirectData subpaths exercised continuously by every healthy flow.
// automation_events is the poisoned one — only CUST_1's recurring run uses
// it on provider B.
const BENIGN_SUBPATHS = ['automation_invocations', 'automation_issues', 'automation_scratch'];

// Per-source completion baselines (events per 15-min bin) the emitter aims
// for; schedule dominates, everything else stays flat.
const SOURCE_BASELINES = {
  schedule: { min: 200, max: 390 },
  chat: { min: 8, max: 16 },
  vcs: { min: 10, max: 20 },
  webhook: { min: 12, max: 24 },
  manual: { min: 0, max: 6 },
};

// Unrelated platform services whose routine warnings share the incident
// dashboards with the automations metrics.
const DECOY_SERVICES = [
  'scheduler-ui', 'billing-sync', 'notifications-relay', 'usage-metering',
  'audit-export', 'session-gc', 'webhook-fanout', 'search-indexer',
];

module.exports = { ENTERPRISES, LONG_TAIL_COUNT, longTailOrgs, BENIGN_SUBPATHS, SOURCE_BASELINES, DECOY_SERVICES };
