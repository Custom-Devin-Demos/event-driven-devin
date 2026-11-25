jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn() },
  initSentry: jest.fn(),
}));
jest.mock('../app/services/slack', () => ({
  ownerRotation: (owner) => owner,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 'devin-lead', url: 'https://example.test/sessions/lead' }),
  sendDevinSessionMessage: jest.fn().mockResolvedValue({ sessionId: 'bot-conv', url: 'https://example.test/sessions/bot' }),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

const slack = require('../app/services/slack');
const devinApi = require('../app/services/devin-api');
const analytics = require('../app/services/oncall-verticals/portfolio-analytics');
const oncallRoutes = require('../app/routes/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

const SLUG = '79ab6e09';
const TITLE = 'Portfolio Analytics | Capital Group Investment Workbench';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', `${SLUG}.html`), 'utf8');
const ENV_KEYS = ['SLACK_ONCALL_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_ONCALL_ALERTS_CHANNEL_ID', 'PORTFOLIO_ANALYTICS_ONCALL_BOT_ID', 'DEVIN_ONCALL_BOT_ID', 'ONCALL_REPO_URL'];
const savedEnv = {};

/** Virtual clock: sleeps advance it by their duration; concurrent sleeps overlap. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      const wake = t + ms;
      return Promise.resolve().then(() => { t = Math.max(t, wake); });
    },
  };
}

async function slowResult() {
  const clock = virtualClock();
  return analytics.refreshAnalytics(clock);
}

beforeEach(() => {
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
  process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C_TEST';
  analytics.resetIncidentsForTests();
  jest.clearAllMocks();
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
});

describe('79ab6e09 portfolio analytics service', () => {
  test('snapshot is synthetic, sums to ~100% and hides service internals', () => {
    const snap = analytics.getSnapshot();
    expect(snap.holdings).toHaveLength(36);
    const total = snap.holdings.reduce((sum, h) => sum + h.weightPct, 0);
    expect(total).toBeGreaterThan(99.5);
    expect(total).toBeLessThan(100.5);
    expect(snap.sectors).toHaveLength(6);
    expect(snap.regions).toHaveLength(4);
    expect(JSON.stringify(snap)).not.toMatch(/factorReadMs|concurrency/i);
    snap.holdings.forEach((h) => expect(h.id).toMatch(/^SYN-\d{4}$/));
  });

  test('Run analytics reads every holding once and takes ~9s against the 2s budget (planted defect)', async () => {
    const result = await slowResult();
    expect(result.ok).toBe(true);
    expect(result.factorReads).toBe(36);
    expect(result.factors).toHaveLength(5);
    expect(result.overBudget).toBe(true);
    expect(result.durationMs).toBeGreaterThan(8000);
    expect(result.durationMs).toBeLessThan(10000);
    const read = result.spans.find((s) => s.name === 'analytics.risk_model_factor_read');
    expect(read.count).toBe(36);
    expect(analytics.RISK_MODEL_CONFIG.factorReadConcurrency).toBe(1);
  });

  test('an over-budget run posts one alert and pages the OnCall Bot; repeats join the incident', async () => {
    const result = await slowResult();
    const first = analytics.raiseIncident(result, { nowMs: 1000 });
    expect(first.created).toBe(true);
    await first.outcome;
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    const [, channel, text] = slack.postMessage.mock.calls[0];
    expect(channel).toBe('C_TEST');
    expect(text).toContain('portfolio-analytics-api');
    expect(text).toContain(first.incident.reference);
    expect(text).not.toMatch(/\u2014|concurren|\.js|factor/i);
    expect(devinApi.sendDevinSessionMessage).toHaveBeenCalledTimes(1);
    const [botId, page] = devinApi.sendDevinSessionMessage.mock.calls[0];
    expect(botId).toBe(analytics.DEFAULT_ONCALL_BOT_ID);
    expect(page).toContain('RUNBOOK');
    expect(page).toContain('thread_ts=1700000000.000100');
    expect(devinApi.createDevinSession).not.toHaveBeenCalled();
    expect(slack.postThreadReply).toHaveBeenCalledTimes(1);
    expect(first.incident.bot.url).toBe('https://example.test/sessions/bot');

    const second = analytics.raiseIncident(result, { nowMs: 2000 });
    expect(second.created).toBe(false);
    expect(second.incident.reference).toBe(first.incident.reference);
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
  });

  test('a failed Bot page falls back to a plain Devin session', async () => {
    devinApi.sendDevinSessionMessage.mockResolvedValueOnce(null);
    const raised = analytics.raiseIncident(await slowResult(), { nowMs: 1000 });
    await raised.outcome;
    expect(devinApi.createDevinSession).toHaveBeenCalledTimes(1);
    expect(raised.incident.session.url).toBe('https://example.test/sessions/lead');
    expect(raised.incident.bot).toBeNull();
  });

  test('responder mode "channel" posts the card only and "off" starts a plain session', async () => {
    process.env.PORTFOLIO_ANALYTICS_ONCALL_BOT_ID = 'channel';
    const raised = analytics.raiseIncident(await slowResult(), { nowMs: 1000 });
    await raised.outcome;
    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    expect(devinApi.sendDevinSessionMessage).not.toHaveBeenCalled();
    expect(devinApi.createDevinSession).not.toHaveBeenCalled();
    process.env.PORTFOLIO_ANALYTICS_ONCALL_BOT_ID = 'off';
    expect(analytics.responderMode()).toEqual({ mode: 'session', botId: null });
  });

  test('the runbook targets the branch named in ONCALL_REPO_URL and never merges', async () => {
    const result = await slowResult();
    expect(analytics.buildSessionPrompt(result, { reference: 'PA-test' })).toContain('branch main');
    process.env.ONCALL_REPO_URL = 'https://github.com/COG-GTM/event-driven-devin/tree/devin/some-branch';
    const prompt = analytics.buildSessionPrompt(result, { reference: 'PA-test' });
    expect(prompt).toContain('against branch devin/some-branch');
    expect(prompt).toContain('Do NOT merge');
  });
});

describe('79ab6e09 skin and routes', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(oncallRoutes);
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.closeAllConnections();
    server.close(done);
  });

  test('skin is native, unlisted and alert-flow only', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({ company: 'Capital Group', oncallOnly: true, page: { file: `${SLUG}.html`, title: TITLE } });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A CAPITAL GROUP SITE/);
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
  });

  test('serves the page with the disclaimer; report and incident 404', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/${SLUG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain('NOT ACTUALLY A CAPITAL GROUP SITE');
    expect(html).not.toContain('All Demos');
    expect((await fetch(`${baseUrl}/oncall/c/${SLUG}/report`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/oncall/c/${SLUG}/incident`)).status).toBe(404);
  });

  test('customer-visible text has no em dashes and no real fund names', () => {
    const text = `${PAGE}\n${JSON.stringify(getOncallSkin(SLUG))}`;
    expect(text).not.toMatch(/\u2014|&mdash;/);
    expect(text).not.toMatch(/American Funds|Growth Fund of America|EuroPacific|capitalgroup\.com/i);
    expect(PAGE).toContain("fetch(`${API}/refresh`");
  });

  test('GET snapshot is fast and carries no factor data', async () => {
    const res = await fetch(`${baseUrl}/api/oncall/${SLUG}/analytics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.holdings).toHaveLength(36);
    expect(body.factors).toBeUndefined();
  });
});
