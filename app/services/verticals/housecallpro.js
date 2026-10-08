const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../telemetry/logger');

/**
 * Housecall Pro technician app (COG-GTM/event-driven-ios HousecallProMobile).
 *
 * The app's "Report a bug" sheet posts here; the report is mirrored into the
 * Slack intake channel, where a Devin listener automation files the Jira
 * ticket and starts remediation. This endpoint never creates Devin sessions.
 *
 * Env:
 *   HCP_SLACK_INTAKE_CHANNEL — channel ID or #name (default #hcp-bug-intake)
 *   HCP_SLACK_BOT_TOKEN      — token override (default SLACK_ONCALL_BOT_TOKEN,
 *                              then SLACK_BOT_TOKEN)
 */

const BUG_REPORT_PATH = '/api/housecallpro/ios/bug-report';
const APP_SOURCE = 'housecallpro-mobile/ios';
const DEFAULT_CHANNEL = '#hcp-bug-intake';
const SLACK_API_BASE = 'https://slack.com/api';
const MAX_FIELD = 2000;

function intakeChannel() {
  return process.env.HCP_SLACK_INTAKE_CHANNEL || DEFAULT_CHANNEL;
}

function slackToken() {
  return process.env.HCP_SLACK_BOT_TOKEN || process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN || '';
}

function clean(value, max = MAX_FIELD) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[<>]/g, '').replace(/(^|[^\w.+-])@(channel|here|everyone)\b/gi, '$1$2').trim().slice(0, max);
}

function isBugReport(body) {
  return Boolean(body && body.source === APP_SOURCE && clean(body.summary));
}

function normalizeReport(body) {
  const steps = Array.isArray(body.stepsToReproduce)
    ? body.stepsToReproduce.map((s) => clean(s, 300)).filter(Boolean).slice(0, 12)
    : [];
  return {
    reporter: clean(body.reporter, 120) || 'Technician',
    summary: clean(body.summary, 200),
    description: clean(body.description),
    screen: clean(body.screen, 80),
    jobId: clean(body.jobId, 20),
    customer: clean(body.customer, 120),
    serviceZip: clean(body.serviceZip, 10),
    errorCode: clean(body.errorCode, 40),
    errorMessage: clean(body.errorMessage, 300),
    appVersion: clean(body.appVersion, 40),
    build: clean(body.build, 40),
    device: clean(body.device, 80),
    osVersion: clean(body.osVersion, 40),
    occurredAt: clean(body.occurredAt, 40),
    steps,
  };
}

function newReference() {
  return `HCP-BUG-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function buildIntakeMessage(report, reference) {
  const field = (label, value) => (value ? `*${label}:* ${value}` : null);
  const env = [report.appVersion && `v${report.appVersion}${report.build ? ` (${report.build})` : ''}`, report.device, report.osVersion && `iOS ${report.osVersion}`]
    .filter(Boolean)
    .join(' · ');
  const lines = [
    `:beetle: *New bug report — Housecall Pro iOS* · \`${reference}\``,
    `*${report.summary}*`,
    '',
    field('Reported by', report.reporter),
    field('Screen', report.screen),
    field('Job', report.jobId && `#${report.jobId}${report.customer ? ` — ${report.customer}` : ''}`),
    field('Service ZIP', report.serviceZip),
    field('Error', [report.errorCode, report.errorMessage].filter(Boolean).join(' — ')),
    field('App', env),
    field('Occurred', report.occurredAt),
  ].filter((l) => l !== null);
  if (report.description) lines.push('', `>${report.description.replace(/\n/g, '\n>')}`);
  if (report.steps.length) {
    lines.push('', '*Steps to reproduce*');
    report.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  lines.push('', '_Source: HousecallProMobile (COG-GTM/event-driven-ios)_');
  return lines.join('\n');
}

async function postBugReport(body, { post = axios.post } = {}) {
  const report = normalizeReport(body);
  const reference = newReference();
  const channel = intakeChannel();
  const token = slackToken();
  if (!token) {
    throw new Error('Slack token not configured for the Housecall Pro intake channel');
  }
  const text = buildIntakeMessage(report, reference);
  const response = await post(
    `${SLACK_API_BASE}/chat.postMessage`,
    { channel, text, unfurl_links: false, unfurl_media: false },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 },
  );
  if (!response.data || !response.data.ok) {
    throw new Error(`Slack API error: ${response.data && response.data.error}`);
  }
  logger.info('housecallpro: bug report posted to intake', { reference, channel: response.data.channel });
  return { posted: true, reference, channel, ts: response.data.ts, channelId: response.data.channel };
}

module.exports = {
  APP_SOURCE,
  BUG_REPORT_PATH,
  DEFAULT_CHANNEL,
  buildIntakeMessage,
  intakeChannel,
  isBugReport,
  normalizeReport,
  postBugReport,
};
