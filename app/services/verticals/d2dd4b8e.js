const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { getCustomerConfig } = require('../../../config/customers');
const { createSessionAndAlert } = require('../devin-session');
const { declareDatadogIncident } = require('../datadog-incidents');
const { createLinearIssue, addLinearComment } = require('../linear');
const { postLinearIssueLink } = require('../slack');

const SLUG = 'd2dd4b8e';
const SERVICE = `customer-${SLUG}-legal-holds`;
const ROUTE = `/api/${SLUG}/release-custodians`;
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID_D2DD4B8E
  || process.env.LINEAR_TEAM_ID_B25C3F24
  || '3c9f0e1e-54da-442d-8949-a62489060822';
const LINEAR_ASSIGNEE_ID = process.env.LINEAR_ASSIGNEE_ID_D2DD4B8E
  || process.env.LINEAR_ASSIGNEE_ID_B25C3F24
  || '4d616028-0c12-4ad9-b117-0661170e857e';
const LINEAR_STATE_IN_PROGRESS_ID = process.env.LINEAR_STATE_IN_PROGRESS_D2DD4B8E
  || process.env.LINEAR_STATE_IN_PROGRESS_B25C3F24
  || '99c9b96f-39b3-4a09-9112-53c054f3dbab';
const LINEAR_STATE_IN_REVIEW_ID = process.env.LINEAR_STATE_IN_REVIEW_D2DD4B8E
  || process.env.LINEAR_STATE_IN_REVIEW_B25C3F24
  || 'd79ea314-a400-4382-9140-d4861fb4e30f';

const MATTER = {
  id: 'matter-new',
  name: 'New Matter',
  database: 'New Matter — Everlaw Legal Holds Demo Database',
};

const HOLD_NOTICES = [
  {
    id: 'hold-notice-1',
    name: 'Hold Notice',
    status: 'issued',
    directory: 'Demo Directory',
    issuedOn: 'May 1',
  },
];

const CUSTODIANS = [
  {
    id: 'custodian-alex',
    name: 'Alex',
    holdStatus: 'issued',
    acknowledgementStatus: 'not_acknowledged',
    questionnaireStatus: 'not_responded',
    communicationHistory: ['Hold notice sent May 1', 'Reminder sent May 8'],
  },
  {
    id: 'custodian-chris',
    name: 'Chris',
    holdStatus: 'issued',
    acknowledgementStatus: 'not_acknowledged',
    questionnaireStatus: 'not_responded',
    communicationHistory: ['Hold notice sent May 1', 'Reminder sent May 8'],
  },
  {
    id: 'custodian-dana',
    name: 'Dana',
    holdStatus: 'issued',
    acknowledgementStatus: 'not_acknowledged',
    questionnaireStatus: 'not_responded',
    communicationHistory: ['Hold notice sent May 1', 'Reminder sent May 8'],
  },
];

const RELEASE_NOTICE_TEMPLATES = {
  acknowledged: {
    subject: 'Legal hold release notice',
    body: 'You are no longer required to preserve information for this matter.',
  },
  released: {
    subject: 'Legal hold release notice',
    body: 'This legal hold has already been released.',
  },
};

const REMEDIATION_DIRECTIVE = [
  '!legal_hold_release_triage',
  '',
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Everlaw legal-hold release workflow:',
  `- Service: \`app/services/verticals/${SLUG}.js\``,
  `- Route: \`app/routes/verticals/${SLUG}.js\``,
  `- Page: \`app/public/verticals/${SLUG}.html\` (served at \`/everlaw\`)`,
  '',
  'Before changing code, pull the runtime evidence through your MCP integrations:',
  `- Sentry MCP: find the latest \`TypeError\` issue for service \`${SERVICE}\` and read its stack trace and tags (\`hold_notice\`, \`custodian_count\`).`,
  `- Datadog MCP: query the \`demo.everlaw_legal_holds.custodian_release_failure\` metric by service tag and the SEV-2 incident "Everlaw legal hold custodian release failing".`,
  `Fix the root cause (the release-notice template map, not the crash site), add regression coverage in \`tests/everlaw-legal-holds.test.js\`, and resolve the Datadog incident in the PR description.`,
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function buildRemediationDirective(issue) {
  if (!issue) return REMEDIATION_DIRECTIVE;

  return [
    REMEDIATION_DIRECTIVE,
    '',
    `*Linear ticket:* ${issue.identifier} — ${issue.url}`,
    'The ticket is created in In Progress, and the app comments your session link on it and posts the ticket link in the Slack alert thread. If the ticket is not In Progress or your session link is missing, do only that missing update yourself first.',
    `- As soon as your PR is open: comment on the ticket with the PR URL (Linear MCP \`create_comment\` / or the GraphQL API with \`LINEAR_API_KEY\`), add the PR link to the ticket, and move the ticket to the "In Review" state (id '${LINEAR_STATE_IN_REVIEW_ID}').`,
    '- Do NOT move the ticket to Done. The reviewer moves it to Done after approving and merging the PR.',
    '- If you push follow-up commits after review feedback, leave the ticket In Review and add a short comment.',
  ].join('\n');
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function buildReleaseNotice(custodian, releasedAt) {
  const template = RELEASE_NOTICE_TEMPLATES[custodian.acknowledgementStatus];
  return {
    subject: template.subject,
    body: template.body,
    recipient: custodian.name,
    sentAt: releasedAt,
  };
}

async function releaseCustodians(data = {}) {
  const holdNoticeId = data.holdNoticeId;
  const notice = HOLD_NOTICES.find((candidate) => candidate.id === holdNoticeId);
  if (!notice) {
    throw validationError(`Unknown hold notice: ${holdNoticeId || '(none)'}`, 'UNKNOWN_HOLD_NOTICE');
  }

  const requestedIds = data.custodianIds === undefined ? CUSTODIANS.map(({ id }) => id) : data.custodianIds;
  if (!Array.isArray(requestedIds)) {
    throw validationError('Custodian IDs must be an array.', 'UNKNOWN_CUSTODIAN');
  }
  const unknownId = requestedIds.find((id) => !CUSTODIANS.some((custodian) => custodian.id === id));
  if (unknownId) {
    throw validationError(`Unknown custodian: ${unknownId}`, 'UNKNOWN_CUSTODIAN');
  }

  const selected = CUSTODIANS.filter((custodian) => requestedIds.includes(custodian.id));
  const runRef = uuidv4();
  const startTime = Date.now();
  const metricTags = { hold_notice: holdNoticeId, custodian_count: String(selected.length) };

  try {
    const releasedAt = new Date().toISOString();
    const notices = selected.map((custodian) => buildReleaseNotice(custodian, releasedAt));
    const released = selected.map((custodian, index) => ({
      ...custodian,
      holdStatus: 'released',
      releasedAt,
      notices: [notices[index]],
      communicationHistory: [...custodian.communicationHistory, `Release notice sent ${releasedAt}`],
    }));
    const duration = Date.now() - startTime;

    incrementMetric('everlaw_legal_holds.custodian_release_success', metricTags);
    recordTiming('everlaw_legal_holds.custodian_release_latency', duration, {
      ...metricTags,
      error: 'false',
    });
    return { success: true, holdNoticeId, releasedCustodians: released };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorTags = { ...metricTags, errorClass: error.name };

    incrementMetric('everlaw_legal_holds.custodian_release_failure', errorTags);
    recordTiming('everlaw_legal_holds.custodian_release_latency', duration, {
      ...metricTags,
      error: 'true',
    });
    logger.error('Everlaw legal hold custodian release failed', {
      runRef,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      holdNoticeId,
      custodianCount: selected.length,
      service: SERVICE,
      route: ROUTE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, hold_notice: holdNoticeId },
      extra: { runRef, custodianCount: selected.length },
    });

    declareDatadogIncident({
      title: 'Everlaw legal hold custodian release failing',
      summary: `${error.name}: ${error.message}. Custodians remain on hold because Everlaw could not prepare their release notices.`,
      runRef,
      service: SERVICE,
      triggeredBy: data.devinEmail || 'legal-hold-release',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((err) => logger.warn('Failed to declare Datadog incident for Everlaw legal hold release', {
      error: err.message,
      runRef,
    }));

    (async () => {
      let issue = null;
      try {
        issue = await createLinearIssue({
          title: `[Everlaw legal holds] ${error.name}: ${error.message}`,
          description: [
            'Everlaw cannot release custodians from the issued legal hold in the Legal Holds admin workflow.',
            '',
            `- Service: \`${SERVICE}\``,
            `- Route: \`POST ${ROUTE}\``,
            `- Release ref: \`${runRef}\``,
            `- Error: \`${error.name}: ${error.message}\``,
            '',
            `Repository: https://github.com/COG-GTM/event-driven-devin (\`app/services/verticals/${SLUG}.js\`).`,
            `Sentry has the stack trace for this service; Datadog has a SEV-2 incident "Everlaw legal hold custodian release failing".`,
            '',
            'Triage with the `!legal_hold_release_triage` playbook.',
          ].join('\n'),
          teamId: LINEAR_TEAM_ID,
          assigneeId: LINEAR_ASSIGNEE_ID,
          priority: 2,
          stateId: LINEAR_STATE_IN_PROGRESS_ID,
        });
      } catch (err) {
        logger.warn('Failed to create Linear issue for Everlaw legal hold release', {
          error: err.message,
          runRef,
        });
      }

      const outcome = await createSessionAndAlert({
        issueTitle: `${error.name}: ${error.message}`,
        issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
        culprit: `app/services/verticals/${SLUG}.js — buildReleaseNotice`,
        errorType: error.name || 'Error',
        errorValue: error.message,
        devinUserId: data.devinUserId,
        devinEmail: data.devinEmail,
        devinOrgId: data.devinOrgId,
        service: SERVICE,
        verticalLabel: 'Everlaw Legal Holds — Release Custodians',
        promptAppendix: buildRemediationDirective(issue),
        customer: SLUG,
        tags: [
          { key: 'route', value: ROUTE },
          { key: 'service', value: SERVICE },
          { key: 'hold_notice', value: holdNoticeId },
          { key: 'custodian_count', value: String(selected.length) },
        ],
        extra: { runRef, holdNoticeId, custodianCount: selected.length },
        level: 'error',
        platform: 'node',
        firstSeen: '',
        lastSeen: new Date().toISOString(),
        count: '',
        shortId: '',
        project: 'event-driven-devin',
        release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
        environment: process.env.DD_ENV || 'prod',
        triggeredRule: '',
      });

      if (issue && outcome && outcome.threadTs) {
        try {
          await postLinearIssueLink(
            outcome.threadTs,
            issue,
            getCustomerConfig(SLUG).slackChannelId || undefined,
          );
        } catch (err) {
          logger.warn('Failed to post Linear issue link to Slack alert thread', {
            error: err.message,
            identifier: issue.identifier,
            runRef,
          });
        }
      }

      if (issue && outcome && outcome.session) {
        const session = outcome.session;
        const commented = await addLinearComment({
          issueId: issue.id,
          body: [
            `Devin picked this up: ${session.url}`,
            '',
            'The PR link will be posted here and the ticket moved to **In Review** once the fix is ready.',
          ].join('\n'),
        })
          .then(() => true)
          .catch((err) => {
            logger.warn('Failed to comment Devin session on Linear issue', {
              error: err.message,
              identifier: issue.identifier,
              runRef,
            });
            return false;
          });
        logger.info('Linear issue linked to Devin session', {
          identifier: issue.identifier,
          sessionId: session.sessionId,
          runRef,
          commented,
        });
      }
    })().catch((err) => logger.warn('Everlaw legal hold incident follow-up failed', {
      error: err.message,
      runRef,
    }));

    throw error;
  }
}

module.exports = {
  MATTER,
  HOLD_NOTICES,
  CUSTODIANS,
  RELEASE_NOTICE_TEMPLATES,
  releaseCustodians,
  buildReleaseNotice,
  REMEDIATION_DIRECTIVE,
  buildRemediationDirective,
  LINEAR_STATE_IN_PROGRESS_ID,
  LINEAR_STATE_IN_REVIEW_ID,
};
