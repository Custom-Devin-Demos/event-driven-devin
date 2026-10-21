/**
 * Architecture Review Hub — reference data for the Cigna Enterprise
 * Architecture review board (customer c6e2a88f).
 *
 * Applications, teams and architects are fictional. The hub holds no member
 * or patient data: records reference systems, standards and decisions only.
 *
 * Standards catalogue versioning (catalogue-versioning release, 19 Oct 2026):
 * every submission is pinned to the catalogue version in force when it was
 * submitted. The release moved the pin from `standardsVersion` to
 * `catalogueVersion`. Records pinned before the release were back-filled and
 * keep a read-only `standardsVersion` alias for one release cycle so that
 * exports built against the old field keep working; submissions pinned to the
 * newly published catalogue carry `catalogueVersion` only.
 */

const CATALOGUE_VERSIONS = [
  { label: '2026.3', publishedAt: '2026-07-01', status: 'superseded', standards: 142 },
  { label: '2026.4', publishedAt: '2026-10-19', status: 'current', standards: 147 },
];

const STANDARDS = {
  'INT-007': { code: 'INT-007', title: 'Event contracts in the enterprise schema registry', version: 2, domain: 'Integration' },
  'DAT-011': { code: 'DAT-011', title: 'Data classification', version: 5, domain: 'Data' },
  'CLD-004': { code: 'CLD-004', title: 'Shared streaming namespace for regulated workloads', version: 3, domain: 'Cloud' },
  'SEC-012': { code: 'SEC-012', title: 'API gateway authentication', version: 3, domain: 'Security' },
  'SEC-014': { code: 'SEC-014', title: 'Secret rotation', version: 3, domain: 'Security' },
  'SEC-033': { code: 'SEC-033', title: 'Privileged session controls', version: 2, domain: 'Security' },
  'SEC-008': { code: 'SEC-008', title: 'Audit event forwarding', version: 6, domain: 'Security' },
  'DAT-019': { code: 'DAT-019', title: 'Cached reference data retention', version: 1, domain: 'Data' },
  'CLD-012': { code: 'CLD-012', title: 'Multi-region resilience', version: 2, domain: 'Cloud' },
};

function pinnedTo(label) {
  const version = CATALOGUE_VERSIONS.find((v) => v.label === label);
  return { label: version.label, publishedAt: version.publishedAt, standards: version.standards };
}

/** Back-fill applied by the catalogue-versioning release to pre-release submissions. */
function withLegacyAlias(submission) {
  return { ...submission, standardsVersion: { ...submission.catalogueVersion } };
}

const SUBMISSIONS = [
  {
    reference: 'ARB-2026-0151',
    application: 'Pharmacy benefits API gateway',
    team: 'Pharmacy Platform Engineering',
    architect: 'Jordan Patel',
    domains: ['Integration', 'Security'],
    submittedAt: '2026-10-20',
    targetDate: '2026-11-03',
    status: 'Waiting on me',
    reviewer: 'Jordan P.',
    catalogueVersion: pinnedTo('2026.4'),
    summary: 'Replace the per-team API gateways in front of pharmacy benefit services with a shared gateway that enforces SEC-012 authentication and per-partner rate limits.',
  },
  withLegacyAlias({
    reference: 'ARB-2026-0149',
    application: 'Provider directory search platform',
    team: 'Provider Data Services',
    architect: 'Marcus Lindqvist',
    domains: ['Data', 'Cloud'],
    submittedAt: '2026-10-17',
    targetDate: '2026-10-31',
    status: 'In review',
    reviewer: 'Marcus L.',
    catalogueVersion: pinnedTo('2026.3'),
    summary: 'Move provider directory search to a managed search cluster with nightly refresh from the provider master.',
  }),
  withLegacyAlias({
    reference: 'ARB-2026-0147',
    application: 'Member portal identity federation',
    team: 'Digital Identity',
    architect: 'Dana Whitfield',
    domains: ['Security'],
    submittedAt: '2026-10-15',
    targetDate: '2026-10-29',
    status: 'Waiting on me',
    reviewer: 'Jordan P.',
    catalogueVersion: pinnedTo('2026.3'),
    summary: 'Federate portal sign-in to the enterprise identity provider and retire the portal-local credential store.',
  }),
  withLegacyAlias({
    reference: 'ARB-2026-0145',
    application: 'Care management streaming migration',
    team: 'Care Management Platform',
    architect: 'Alison Reyes',
    domains: ['Data', 'Integration'],
    submittedAt: '2026-10-10',
    targetDate: '2026-10-17',
    status: 'Overdue',
    reviewer: 'Alison R.',
    catalogueVersion: pinnedTo('2026.3'),
    summary: 'Migrate care plan updates from the overnight extract to the shared streaming platform.',
  }),
  withLegacyAlias({
    reference: 'ARB-2026-0144',
    application: 'Broker quoting document service',
    team: 'Broker Experience',
    architect: 'Priya Natarajan',
    domains: ['Cloud'],
    submittedAt: '2026-10-08',
    targetDate: '2026-10-22',
    status: 'Board scheduled',
    reviewer: 'Priya N.',
    catalogueVersion: pinnedTo('2026.3'),
    summary: 'Generate broker quote documents in a managed rendering service with a 7-year retention store.',
  }),
  withLegacyAlias({
    reference: 'ARB-2026-0142',
    application: 'Claims adjudication event bus',
    team: 'Claims Platform Engineering',
    architect: 'Tom Okafor',
    domains: ['Cloud', 'Data', 'Integration'],
    submittedAt: '2026-09-29',
    targetDate: '2026-10-23',
    status: 'Decided',
    reviewer: 'Jordan P.',
    catalogueVersion: pinnedTo('2026.3'),
    decisionId: 'ADR-2026-031',
    summary: 'Publish adjudication outcomes as governed events on the shared streaming platform.',
  }),
  withLegacyAlias({
    reference: 'ARB-2026-0140',
    application: 'Dental claims imaging archive',
    team: 'Dental Operations Technology',
    architect: 'Alison Reyes',
    domains: ['Data'],
    submittedAt: '2026-09-26',
    targetDate: '2026-10-10',
    status: 'Overdue',
    reviewer: 'Unassigned',
    catalogueVersion: pinnedTo('2026.3'),
    summary: 'Consolidate dental claim images into the enterprise object archive with lifecycle tiering.',
  }),
];

const DECISION_OUTCOMES = ['Approved', 'Approved with conditions', 'Rejected', 'Deferred'];

const DECISIONS = [
  {
    id: 'ADR-2026-031',
    submission: 'ARB-2026-0142',
    title: 'Adopt a governed event stream for claims adjudication hand-offs',
    outcome: 'Approved with conditions',
    decidedAt: '2026-10-23',
    chair: 'Elena Moreau',
    boardSession: 'October 2026',
    status: 'Published',
    catalogueVersion: '2026.3',
    owner: 'Enterprise Architecture',
    updatedAt: '2026-10-24',
    supersedes: { id: 'ADR-2025-044', title: 'Nightly batch hand-off as the finance integration pattern (retired).' },
    context: [
      'Claims adjudication currently hands results to finance and reporting systems through nightly batch files. Reconciliation failures are discovered a day late, and three downstream teams maintain their own parsers for the same file layout.',
      'The submitted design publishes adjudication outcomes as governed events on the shared streaming platform so consumers subscribe to a versioned contract instead of a file.',
    ],
    decision: 'The board approves the event stream design with conditions. Adjudication outcomes become the system of record event for downstream finance posting; the nightly batch is retired once two consumers have migrated.',
    decisionPoints: [
      'Events are published to the shared streaming namespace, not a team-owned cluster (CLD-004 v3).',
      'Every schema is registered and versioned in the enterprise schema registry (INT-007 v2).',
      'The finance ledger topic is classified Confidential with field-level encryption for member identifiers (DAT-011 v5).',
    ],
    conditions: [
      { text: 'Register all published schemas before go-live', standard: 'INT-007 v2', due: '2026-11-20', status: 'Open' },
      { text: 'Classify and encrypt the finance ledger topic', standard: 'DAT-011 v5', due: '2026-11-20', status: 'Open' },
      { text: 'Move consumers to the shared streaming namespace', standard: 'CLD-004 v3', due: '2026-10-17', status: 'Addressed' },
    ],
    consequences: [
      'Downstream teams replace file parsers with a single versioned subscription, and reconciliation moves from next-day to near real time. The platform team takes on capacity for an estimated 1.2 million events per day.',
      'Until the conditions are confirmed the nightly batch continues to run in parallel, which doubles finance posting load for up to six weeks.',
    ],
    linkedExceptions: ['EXC-2026-018'],
    relatedSubmissions: [
      { reference: 'ARB-2026-0142', application: 'Claims adjudication event bus', decidedAt: '2026-10-23', outcome: 'Approved with conditions' },
      { reference: 'ARB-2026-0119', application: 'Finance ledger streaming consumer', decidedAt: '2026-09-11', outcome: 'Approved' },
    ],
  },
];

const RELATED_DECISIONS = [
  { id: 'ADR-2026-027', title: 'Shared streaming namespace for regulated workloads', decidedAt: '2026-09-25', chair: 'Elena Moreau', outcome: 'Approved' },
  { id: 'ADR-2026-022', title: 'Enterprise schema registry as the single source for event contracts', decidedAt: '2026-08-28', chair: 'Tom Okafor', outcome: 'Approved' },
  { id: 'ADR-2026-019', title: 'Team-owned Kafka cluster for claims analytics', decidedAt: '2026-07-31', chair: 'Elena Moreau', outcome: 'Rejected' },
  { id: 'ADR-2026-015', title: 'Field-level encryption for member identifiers in transit', decidedAt: '2026-06-26', chair: 'Tom Okafor', outcome: 'Deferred' },
];

const EXCEPTIONS = [
  { id: 'EXC-2026-018', standard: 'DAT-011 v5', application: 'Claims adjudication event bus', owner: 'Marcus L.', compensatingControl: 'Topic-level encryption and quarterly access review', reviewDate: '2026-12-15', expiresAt: '2027-01-31', status: 'Active', description: 'DAT-011 Data classification v5 — interim classification for the legacy ledger topic' },
  { id: 'EXC-2026-017', standard: 'SEC-033 v2', application: 'Broker quoting document service', owner: 'Dana W.', compensatingControl: 'Session recording and 8-hour re-authentication', reviewDate: '2026-11-01', expiresAt: '2026-11-15', status: 'Expiring' },
  { id: 'EXC-2026-015', standard: 'CLD-004 v3', application: 'Dental claims imaging archive', owner: 'Alison R.', compensatingControl: 'Dedicated cluster isolated by network policy', reviewDate: '2026-10-10', expiresAt: '2026-11-30', status: 'Review overdue' },
  { id: 'EXC-2026-014', standard: 'INT-007 v2', application: 'Care management streaming migration', owner: 'Jordan P.', compensatingControl: 'Schemas versioned in the team repository', reviewDate: '2026-11-20', expiresAt: '2026-12-20', status: 'Active' },
  { id: 'EXC-2026-012', standard: 'SEC-014 v3', application: 'Pharmacy benefits API gateway', owner: 'Priya N.', compensatingControl: 'Manual rotation with change ticket evidence', reviewDate: '2026-10-05', expiresAt: '2026-11-14', status: 'Review overdue' },
  { id: 'EXC-2026-011', standard: 'DAT-019 v1', application: 'Provider directory search platform', owner: 'Marcus L.', compensatingControl: 'Nightly purge of cached provider records', reviewDate: '2026-12-01', expiresAt: '2027-02-28', status: 'Active' },
  { id: 'EXC-2026-009', standard: 'CLD-012 v2', application: 'Member portal identity federation', owner: 'Dana W.', compensatingControl: 'Single-region deployment with warm standby', reviewDate: '2026-11-18', expiresAt: '2026-11-18', status: 'Expiring' },
  { id: 'EXC-2026-006', standard: 'SEC-008 v6', application: 'Finance ledger streaming consumer', owner: 'Tom O.', compensatingControl: 'Audit events forwarded to the central log platform', reviewDate: '2026-10-31', expiresAt: '2027-03-31', status: 'Active' },
];

function findSubmission(reference) {
  const needle = String(reference || '').trim().toUpperCase();
  return SUBMISSIONS.find((s) => s.reference === needle) || null;
}

function findDecision(id) {
  const needle = String(id || '').trim().toUpperCase();
  return DECISIONS.find((d) => d.id === needle) || null;
}

module.exports = {
  CATALOGUE_VERSIONS,
  STANDARDS,
  SUBMISSIONS,
  DECISIONS,
  DECISION_OUTCOMES,
  RELATED_DECISIONS,
  EXCEPTIONS,
  findSubmission,
  findDecision,
};
