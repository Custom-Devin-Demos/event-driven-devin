/**
 * Cigna Enterprise Architecture — Architecture Review Hub (customer c6e2a88f).
 *
 * Review queue, decision records and the exception register for the
 * architecture review board. The primary EA action is "Record decision" on
 * the Decision record screen, which turns a reviewed submission into an
 * Architecture Decision Record pinned to the standards catalogue version in
 * force when the submission was made.
 *
 * Failures on the record path raise a ServiceNow incident for the EA platform
 * team; the ServiceNow dispatch rule starts the Devin session from that
 * incident and the session writes its findings and the fix PR back to it.
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  CATALOGUE_VERSIONS,
  STANDARDS,
  SUBMISSIONS,
  DECISIONS,
  DECISION_OUTCOMES,
  RELATED_DECISIONS,
  EXCEPTIONS,
  findSubmission,
  findDecision,
} = require('./c6e2a88f-submissions');

const SERVICE = 'customer-c6e2a88f-architecture-review-hub';
const CI_NAME = 'Architecture Review Hub';
const CUSTOMER = 'c6e2a88f';
const ROUTE = '/api/c6e2a88f/decisions';
const ASSIGNMENT_GROUP = 'Enterprise Architecture Platform Engineering';

/** Slack member to page when a decision cannot be recorded and no requester email is known. */
const ONCALL_SLACK_MEMBER_ID = process.env.DEMO_ONCALL_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Investigation directive appended to the Devin prompt. The incident
 * description is the only context Devin receives from the ServiceNow dispatch,
 * so the repository to remediate is named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Cigna Enterprise Architecture — Architecture Review Hub vertical:',
  '- Service: `app/services/verticals/c6e2a88f.js`',
  '- Submissions, decisions, standards catalogue & exception register data: `app/services/verticals/c6e2a88f-submissions.js`',
  '- Route: `app/routes/verticals/c6e2a88f.js`',
  '- Page: `app/public/verticals/c6e2a88f.html` (served at `/c6e2a88f`, `/arb-hub` and `/architecture-review-hub`)',
  '- Prevention control: `scripts/c6e2a88f-catalogue-audit.js` (`npm run audit:c6e2a88f`)',
  '',
  '*Treat this as a field-migration defect, not a one-line crash.* The catalogue-versioning release (19 Oct 2026) renamed the standards catalogue pin on submissions from `standardsVersion` to `catalogueVersion` (see `c6e2a88f-submissions.js`). Submissions pinned before the release were back-filled and still carry the old alias, so every decision recorded so far has succeeded; the first submissions pinned to the newly published catalogue 2026.4 carry the new field only, and "Record decision" fails for all of them.',
  '',
  '*Remediation plan — once the crash is root-caused, run these three workstreams in parallel as child sessions, wait for them, then summarize in the ServiceNow incident:*',
  '1. *Blast radius in code* — find every reader of the old field in the service (decision record, review queue, exception register, exports and telemetry). Route all of them through one shared catalogue resolver that fails loudly when a submission has no pinned catalogue version, remove the dependency on the legacy alias, add regression tests for a pre-release submission and a 2026.4 submission, run `npm test` and `npm run lint`.',
  `2. *Blast radius in ServiceNow* — using the same Table API credentials as the incident write-back, query open incidents in assignment group "${ASSIGNMENT_GROUP}" (state < 6) that predate this incident and mention decision records, catalogue versions or standards versions. Decide which are the same defect reported by other reviewers. For each: add a work note linking this incident and the fix PR and set \`parent_incident\` to this incident sys_id. Report their numbers and count.`,
  '3. *Prevention* — run `npm run audit:c6e2a88f`. It resolves the pinned catalogue version for every submission through the decision-record path and exits non-zero on any submission that cannot be resolved; it is not wired into CI, which is why this shipped. Wire it into `npm test` (or the CI workflow) so a catalogue pin gap fails before it ships.',
  '',
  'Fold all code workstreams into a single pull request against `main`. If a child session cannot reach ServiceNow, perform workstream 2 from the parent session. Do not deploy and do not close or resolve the incident: the assignment group owns the release and closes the incident after review. The final ServiceNow work note must state: root cause, submissions affected, routes fixed, prevention control added, PR URL.',
].join('\n');

function submissionNotFound() {
  const error = new Error('Submission not found. Check the reference and try again.');
  error.name = 'SubmissionNotFoundError';
  error.statusCode = 404;
  error.code = 'SUBMISSION_NOT_FOUND';
  return error;
}

function invalidOutcome() {
  const error = new Error(`Outcome must be one of: ${DECISION_OUTCOMES.join(', ')}.`);
  error.name = 'ValidationError';
  error.statusCode = 400;
  error.code = 'INVALID_OUTCOME';
  return error;
}

function daysBetween(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000);
}

/** Today for age and due-date arithmetic — the board calendar runs on the review date, not wall clock. */
const REVIEW_DATE = '2026-10-21';

function queueRow(submission) {
  return {
    reference: submission.reference,
    application: submission.application,
    domains: submission.domains,
    submittedAt: submission.submittedAt,
    ageDays: daysBetween(submission.submittedAt, REVIEW_DATE),
    targetDate: submission.targetDate,
    status: submission.status,
    reviewer: submission.reviewer,
    catalogueVersion: submission.catalogueVersion.label,
  };
}

function getReviewQueue() {
  const rows = SUBMISSIONS.map(queueRow);
  return {
    summary: {
      waitingOnMe: { value: 6, note: '2 due today' },
      dueThisWeek: { value: 9, note: '3 assigned to me' },
      overdue: { value: 2, note: 'Oldest is 4 days late' },
      decidedThisMonth: { value: 14, note: '93% within target' },
    },
    rows,
    total: 31,
    catalogueVersions: CATALOGUE_VERSIONS,
  };
}

function getExceptionRegister() {
  return {
    summary: {
      expiring30: { value: 3, note: 'Owners notified' },
      expiring60: { value: 5, note: '1 renewal requested' },
      expiring90: { value: 8, note: 'On track' },
      overdueReview: { value: 2, note: 'Escalated to the chair' },
    },
    rows: EXCEPTIONS,
    total: 23,
  };
}

/**
 * Standards in scope for a decision, pinned to the catalogue version that was
 * in force when the submission was made (ADR-0012).
 */
function pinStandards(submission, standardCodes) {
  const catalogue = submission.standardsVersion.label;
  return standardCodes.map((code) => {
    const standard = STANDARDS[code];
    return standard
      ? `${standard.code} v${standard.version} (catalogue ${catalogue})`
      : `${code} (catalogue ${catalogue})`;
  });
}

function nextDecisionId() {
  const latest = Math.max(...DECISIONS.map((d) => Number(d.id.split('-').pop())));
  return `ADR-2026-${String(latest + 1).padStart(3, '0')}`;
}

function decisionView(decision) {
  const submission = findSubmission(decision.submission);
  return {
    ...decision,
    submissionTitle: submission ? submission.application : '',
    domains: submission ? submission.domains : [],
    linkedExceptions: decision.linkedExceptions
      .map((id) => EXCEPTIONS.find((e) => e.id === id))
      .filter(Boolean),
    relatedDecisions: RELATED_DECISIONS,
  };
}

/**
 * Decision record for a submission: the published ADR when the board has
 * decided, otherwise the open record the chair completes with "Record decision".
 */
function getDecisionRecord(reference) {
  const submission = findSubmission(reference);
  if (!submission) throw submissionNotFound();
  const published = submission.decisionId ? findDecision(submission.decisionId) : null;
  return {
    submission: {
      reference: submission.reference,
      application: submission.application,
      team: submission.team,
      architect: submission.architect,
      domains: submission.domains,
      submittedAt: submission.submittedAt,
      status: submission.status,
      catalogueVersion: submission.catalogueVersion.label,
      summary: submission.summary,
    },
    decision: published ? decisionView(published) : null,
    outcomes: DECISION_OUTCOMES,
    relatedDecisions: RELATED_DECISIONS,
  };
}

/**
 * Record the board's decision for a submission as an Architecture Decision Record.
 */
async function recordDecision(data = {}) {
  const startTime = Date.now();
  const recordId = uuidv4();
  const submission = findSubmission(data.reference);
  if (!submission) throw submissionNotFound();
  if (!DECISION_OUTCOMES.includes(data.outcome)) throw invalidOutcome();

  const standardCodes = Array.isArray(data.standards) && data.standards.length
    ? data.standards
    : submission.domains.flatMap((domain) => Object.values(STANDARDS).filter((s) => s.domain === domain).map((s) => s.code));

  logger.info('Recording architecture decision', {
    recordId,
    reference: submission.reference,
    outcome: data.outcome,
    catalogueVersion: submission.catalogueVersion.label,
    service: SERVICE,
  });

  try {
    const standards = pinStandards(submission, standardCodes);
    const decision = {
      id: nextDecisionId(),
      submission: submission.reference,
      application: submission.application,
      outcome: data.outcome,
      title: String(data.title || '').trim() || `Decision on ${submission.application}`,
      rationale: String(data.rationale || '').trim(),
      conditions: Array.isArray(data.conditions) ? data.conditions.map((c) => String(c).trim()).filter(Boolean) : [],
      standards,
      catalogueVersion: submission.catalogueVersion.label,
      chair: data.chair || 'Elena Moreau',
      decidedAt: REVIEW_DATE,
      status: 'Published',
    };

    incrementMetric('decision.record.success', { route: ROUTE, outcome: data.outcome, catalogue: decision.catalogueVersion });
    recordTiming('decision.record.latency', Date.now() - startTime, { route: ROUTE });

    return { success: true, recordId, decision };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('decision.record.failure', { route: ROUTE, errorClass: error.name, catalogue: submission.catalogueVersion.label });
    recordTiming('decision.record.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Recording architecture decision failed', {
      recordId,
      reference: submission.reference,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { service: SERVICE, route: ROUTE, reference: submission.reference, alert_path: 'instant' },
      extra: { recordId, catalogueVersion: submission.catalogueVersion.label, outcome: data.outcome },
    });

    createSessionAndAlert({
      title: `Architecture Review Hub — Record decision fails (${error.name}) for submissions pinned to standards catalogue ${submission.catalogueVersion.label}; first seen on ${submission.reference}`,
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/c6e2a88f.js \u2014 pinStandards',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: CI_NAME,
      verticalLabel: 'Cigna Enterprise Architecture \u2014 Architecture Review Hub',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: CUSTOMER,
      slackMemberId: data.devinEmail ? '' : ONCALL_SLACK_MEMBER_ID,
      slackMemberIdFallback: ONCALL_SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'reference', value: submission.reference },
        { key: 'catalogueVersion', value: submission.catalogueVersion.label },
      ],
      extra: { recordId, catalogueVersion: submission.catalogueVersion.label, outcome: data.outcome },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to raise incident for decision record error', { recordId, error: alertError.message });
    });

    throw error;
  }
}

module.exports = {
  SERVICE,
  CI_NAME,
  CUSTOMER,
  ROUTE,
  ASSIGNMENT_GROUP,
  REMEDIATION_DIRECTIVE,
  REVIEW_DATE,
  getReviewQueue,
  getExceptionRegister,
  getDecisionRecord,
  recordDecision,
  pinStandards,
};
