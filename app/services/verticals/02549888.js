/* global performance, setImmediate */

const { randomUUID } = require('node:crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  claimLatencyAlert,
  latencyAlertKey,
  releaseLatencyAlert,
  startedInvestigation,
} = require('../latency-alert-cooldown');

const SLACK_MEMBER_ID = process.env.HEALTHIE_SLACK_MEMBER_ID || '';
const ROUTE = '/api/02549888/demo-requests';
const SERVICE = 'customer-02549888-demo-request';
const LATENCY_SLO = { budgetMs: 3000 };
const SCHEDULER_POLICY = { lookupMs: 500 };
const OPTIONS = {
  teamSize: ['Just Me!', '2-5', '6-10', '11-50', '50+'],
  techRequirement: [
    'API access', 'White-labeling (enterprise plans only)', 'Custom branding & logo (all plans)',
    'Ability to go fully headless (dev team on staff)', 'Sub-orgs (multiple business entities)',
    'More than one of these', 'None of these',
  ],
  challenge: [
    'AI Functionality', 'Slow Documentation', 'Billing Concerns', 'Patient Engagement (scheduling, follow ups, etc.)',
    'Interoperability Challenges', 'No API / Lack API', 'Difficulty Measuring Outcomes', 'Other',
  ],
};
const PREFILL = {
  firstName: 'Jordan',
  lastName: 'Lee',
  email: 'jordan.lee@example.com',
  company: 'Northstar Wellness',
  teamSize: '11-50',
  techRequirement: 'API access',
  challenge: 'Slow Documentation',
};
const GROUP_CALENDARS = [
  'east', 'central', 'mountain', 'west', 'canada', 'international',
  'nutrition', 'behavioral-health', 'primary-care', 'specialty-care',
  'billing', 'integrations', 'implementation', 'solutions',
];

function readText(data, key) {
  return typeof data[key] === 'string' ? data[key].trim() : '';
}

function validateDemoRequest(data) {
  const firstName = readText(data, 'firstName');
  const lastName = readText(data, 'lastName');
  const email = readText(data, 'email');
  const company = readText(data, 'company');
  const teamSize = readText(data, 'teamSize');
  const techRequirement = readText(data, 'techRequirement');
  const challenge = readText(data, 'challenge');
  let message;
  if (!firstName || !lastName || !company) message = 'Enter your first name, last name, and company.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) message = 'Enter a valid work email address.';
  else if (!OPTIONS.teamSize.includes(teamSize)) message = 'Choose a valid team size.';
  else if (!OPTIONS.techRequirement.includes(techRequirement)) message = 'Choose a valid tech requirement.';
  else if (challenge && !OPTIONS.challenge.includes(challenge)) message = 'Choose a valid challenge.';
  if (message) throw Object.assign(new Error(message), { statusCode: 400 });

  return {
    teamSize,
    devinUserId: readText(data, 'devinUserId'),
    devinOrgId: readText(data, 'devinOrgId'),
    devinEmail: readText(data, 'devinEmail'),
  };
}

async function lookupAvailability(calendar) {
  await new Promise((resolve) => setTimeout(resolve, SCHEDULER_POLICY.lookupMs));
  return { calendar, nextSlotHours: calendar.length };
}

async function findDemoCalendar(teamSize) {
  const calendars = teamSize === '11-50' ? GROUP_CALENDARS : [teamSize === '50+' ? 'enterprise' : 'small-practice'];
  const availability = [];
  for (const calendar of calendars) {
    availability.push(await lookupAvailability(calendar));
  }
  const earliest = availability.reduce((best, slot) => slot.nextSlotHours < best.nextSlotHours ? slot : best);
  return { calendar: earliest.calendar, calendarsChecked: availability.length };
}

async function reportLatencyBreach({ data, requestId, durationMs, calendarsChecked }) {
  const { budgetMs } = LATENCY_SLO;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';
  const tags = { route: ROUTE, service: SERVICE, alert_path: 'latency', team_size: data.teamSize };
  const extra = { requestId, durationMs, budgetMs, calendarsChecked };
  Sentry.captureException(error, { level: 'warning', tags, extra });

  const key = latencyAlertKey('02549888', data.devinOrgId);
  const claim = claimLatencyAlert(key);
  if (!claim) return;

  try {
    const result = await createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/02549888.js — findDemoCalendar',
      errorType: error.name,
      errorValue: error.message,
      customer: '02549888',
      verticalLabel: 'Healthie — See a Demo',
      service: SERVICE,
      level: 'warning',
      platform: 'node',
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: Object.entries(tags).map(([tag, value]) => ({ key: tag, value })),
      extra,
      promptAppendix: 'Reproduce at /healthie/see-a-demo?reports=off with the pre-filled 11-50 team size. Investigate findDemoCalendar, preserve the calendar selection and the 3000ms budget, and open a PR with before/after timings and a regression test for the single-calendar path.',
    });
    if (!startedInvestigation(result)) releaseLatencyAlert(key, claim);
  } catch (alertError) {
    releaseLatencyAlert(key, claim);
    logger.error('Failed to create Devin session for Healthie demo request', { requestId, error: alertError.message });
  }
}

async function submitDemoRequest(raw, { rehearsal = false } = {}) {
  const data = validateDemoRequest(raw);
  const requestId = randomUUID();
  const start = performance.now();
  const routing = await findDemoCalendar(data.teamSize);
  const durationMs = Math.round(performance.now() - start);
  const { budgetMs } = LATENCY_SLO;
  const budgetExceeded = durationMs > budgetMs;
  const metricTags = { route: ROUTE, team_size: data.teamSize };
  recordTiming('healthie.demo_request.latency', durationMs, metricTags);

  if (budgetExceeded) {
    incrementMetric('healthie.demo_request.latency_budget_breach', metricTags);
    logger.warn('Healthie demo request exceeded latency budget', {
      requestId, durationMs, budgetMs, calendarsChecked: routing.calendarsChecked, rehearsal,
    });
    if (!rehearsal) setImmediate(() => reportLatencyBreach({ data, requestId, durationMs, ...routing }));
  }

  return { success: true, requestId, durationMs, budgetMs, budgetExceeded, ...routing };
}

module.exports = { submitDemoRequest, OPTIONS, PREFILL, LATENCY_SLO, SCHEDULER_POLICY };
