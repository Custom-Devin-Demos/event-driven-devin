/* global afterAll, afterEach, beforeAll, beforeEach, describe, expect, fetch, jest, test */

jest.mock('axios');
jest.mock('../app/telemetry/datadog', () => ({
  ...jest.requireActual('../app/telemetry/datadog'),
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));
jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 'session-abc', url: 'https://app.devin.ai/sessions/session-abc' }),
}));

const express = require('express');
const http = require('http');
const axios = require('axios');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const { ALERT_SCENARIOS, resetSkinAlertMemory } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

const SLUG = '77c11f38';
const TITLE = 'Check your eligibility | Homeowner loans | TogetherMoney';
const ROUTE = '/api/oncall/eligibility/check';
const ONCALL_DEMO_URL = 'https://default8019.65.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=x';
const ENV_KEYS = ['SLACK_ONCALL_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_ONCALL_ALERTS_CHANNEL_ID', 'ONCALL_TEAMS_WEBHOOK_URL', 'ONCALL_TEAMS_ALL_ALERTS', 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const APPLICANT = { loanAmount: '40,000', propertyValue: '325,000', postcode: 'M3 3HF', consent: true };

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(oncallVerticalRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(() => stopGateway().then(() => done()));
});

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('TogetherMoney website eligibility on-call skin (77c11f38)', () => {
  beforeEach(() => {
    resetSkinAlertMemory();
    jest.clearAllMocks();
    ENV_KEYS.forEach((k) => delete process.env[k]);
    axios.post.mockResolvedValue({ status: 202 });
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
  });

  test('is a Teams-routed, unlisted eligibility skin with no app-created Devin session', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({
      vertical: 'eligibility',
      oncallOnly: true,
      teamsAlerts: true,
      teamsWebhookEnv: 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI',
      page: { file: `${SLUG}.html`, title: TITLE },
      alertCard: { service: 'together-website-eligibility', team: 'website-oncall' },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.alertDestination).toBeUndefined();
    expect(skin.alertCard.metricQuery).toBe(ALERT_SCENARIOS.eligibility.metricQuery);
    expect(skin.alertCard.metricQuery).toContain('demo.together_website.eligibility.failure');
    expect(skin.alertCard.metricQuery).toContain(`route:${ROUTE}`);
    expect(skin.alertCard.metricQuery).toContain('status_class:5xx');
    expect(skin.alertCard.title).toContain(`POST ${ROUTE}`);
    expect(skin.alertCard.service).not.toMatch(/together ?money/i);
    expect(ALERT_SCENARIOS.eligibility).toMatchObject({
      apiPath: `/api/${SLUG}/eligibility`, oncallApiPath: ROUTE, alertOnStatus: [500], defaultAlertDestination: 'teams', unlisted: true,
    });
    expect(getOncallSkin('5756ef9b')).toMatchObject({ vertical: 'banking', paths: ['/oncall/c/togethermoney', '/togethermoney-oncall'] });
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = [`/oncall/c/${SLUG}`, `/${SLUG}`, '/togethermoney-website', '/oncall/c/togethermoney-website'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    pages.slice(1).forEach((page) => expect(page).toEqual(pages[0]));
    const html = pages[0];
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain('Check your eligibility');
    expect(html).toContain(`fetch('/api/${SLUG}/eligibility'`);
    expect(html).toContain(`const oncallApiPath = "${ROUTE}"`);
    expect(html).toContain('const alertOnStatus = [500]');
    ['loanAmount', 'propertyValue', 'employmentType', 'annualIncome', 'postcode', 'consent'].forEach((name) => {
      expect(html).toContain(`name="${name}"`);
    });
    expect(html).not.toMatch(/nCino|Salesforce/i);
  });

  test.each(['45000', '£45,000'])('employed applicant with income %s is eligible', async (annualIncome) => {
    const res = await post(ROUTE, { ...APPLICANT, employmentType: 'employed', annualIncome });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, decision: 'eligible', annualIncome: 45000, ltvPercent: 12.3 });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('self-employed applicant with plain digits is eligible', async () => {
    const res = await post(ROUTE, { ...APPLICANT, employmentType: 'self-employed', annualIncome: '45000' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, annualIncome: 45000 });
  });

  // PLANTED DEMO BUG: the self-employed path skips currency sanitising, so
  // "£45,000" crashes the income normaliser. Flip these once fixed.
  test.each(['£45,000', '45,000'])('PLANTED BUG: self-employed applicant with income %s returns 500 and reports to Sentry', async (annualIncome) => {
    const res = await post(ROUTE, { ...APPLICANT, employmentType: 'self-employed', annualIncome });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'ELIGIBILITY_CHECK_FAILED', error: expect.stringMatching(/^Something went wrong/) });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({ service: 'together-website-eligibility', employment_type: 'self-employed' });
    expect(incrementMetric).toHaveBeenCalledWith('together_website.eligibility.failure', expect.objectContaining({ route: ROUTE, employment_type: 'self-employed', status_class: '5xx' }));
  });

  test.each([
    [{ consent: false }, 'CONSENT_REQUIRED'],
    [{ postcode: 'NOTAPOST' }, 'INVALID_POSTCODE'],
    [{ employmentType: 'student' }, 'INVALID_EMPLOYMENT_TYPE'],
  ])('invalid input %j is a 400 (%s), not a page', async (override, code) => {
    const res = await post(ROUTE, { ...APPLICANT, employmentType: 'employed', annualIncome: '45000', ...override });
    expect(res.status).toBe(400);
    expect(incrementMetric).toHaveBeenCalledWith('together_website.eligibility.failure', expect.objectContaining({ status_class: '4xx' }));
    expect(await res.json()).toMatchObject({ success: false, code });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('alert trigger posts the monitor card only to the oncall-demo Teams channel', async () => {
    process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
    process.env.ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI = ONCALL_DEMO_URL;
    const res = await post('/api/oncall/trigger/eligibility', { skin: SLUG, alertDestination: 'teams' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, teams: true });
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, payload] = axios.post.mock.calls[0];
    expect(url).toBe(ONCALL_DEMO_URL);
    const card = JSON.stringify(payload.attachments[0].content);
    expect(card).toContain(`5xx spike \u2014 POST ${ROUTE} (self-employed applicants)`);
    expect(card).toContain('together-website-eligibility (TogetherMoney)');
    expect(card).toContain('website-oncall');
    expect(card).toContain(`/oncall/c/${SLUG}`);
    expect(card).not.toMatch(/TypeError|app\/services|\.js:|parseSelfEmployedIncome/);
  });

  test('an explicit Slack choice from the picker still goes to Slack', async () => {
    process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
    process.env.ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI = ONCALL_DEMO_URL;
    const res = await post('/api/oncall/trigger/eligibility', { skin: SLUG, alertDestination: 'slack' });
    expect(res.status).toBe(200);
    expect(postMessage).toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
});
