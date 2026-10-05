/* global afterEach, beforeEach, describe, expect, jest, test */

jest.mock('../app/services/slack', () => ({
  OWNER_DISCLAIMER: 'fictional on-call persona',
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 's', url: 'https://app.devin.ai/sessions/s' }),
}));

jest.mock('../app/services/sonar-pr-trigger', () => ({
  scheduleVulnerablePR: jest.fn(),
}));

const { postMessage } = require('../app/services/slack');
const { getOncallSkin } = require('../config/oncall-skins');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { postOncallAlert, ALERT_SCENARIOS } = require('../app/services/oncall');

const NOW = new Date('2026-10-02T12:00:00.000Z');

async function postCard(skin) {
  await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
  const [, , text, blocks] = postMessage.mock.calls[postMessage.mock.calls.length - 1];
  return { text, blocks: JSON.stringify(blocks) };
}

describe('per-skin alertCard overrides on the #oncall-alerts card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('fe4f39ba posts vaccine-ordering wording with no banking copy', async () => {
    const skin = getOncallSkin('fe4f39ba');
    const { text, blocks } = await postCard(skin);

    expect(text).toContain(':rotating_light: *[Triggered] Vaccine order submissions hang ~10s*');
    expect(text).toContain('*Service:* vaccine-ordering-api (GSK)');
    expect(text).toContain('*Endpoint:* POST /api/orders/submit');
    expect(text).toContain('*Owner:* Jordan Patel (hcp-ordering-oncall) — fictional on-call persona');
    expect(text).toContain('Release: hcp-ordering-web@1.0.3');
    expect(text).toContain('/oncall/c/fe4f39ba');
    expect(blocks).toContain('[Triggered] Vaccine order submissions hang ~10s');
    expect(blocks).toContain('Service: `vaccine-ordering-api`');
    for (const out of [text, blocks]) {
      expect(out).not.toMatch(/banking|apex|transfer|payments-oncall|checkout-api/i);
    }
  });

  test('fe4f39ba alertCard stays metric-shaped and keeps the company out of identifiers', () => {
    const { alertCard } = getOncallSkin('fe4f39ba');
    for (const key of ['service', 'endpointLabel', 'release', 'team', 'metricQuery']) {
      expect(alertCard[key]).not.toMatch(/gsk/i);
    }
    expect(Object.values(alertCard).join(' ')).not.toMatch(/\.js|TypeError|screening|compliance|premium|tier/i);
  });

  test('a banking skin without alertCard keeps the vertical card text', async () => {
    const skin = getOncallSkin('cb84fd21');
    expect(skin.alertCard).toBeUndefined();
    const scenario = ALERT_SCENARIOS.banking;
    const { text, blocks } = await postCard(skin);

    const firstSeen = new Date(NOW.getTime() - 5 * 60000).toISOString();
    expect(text).toBe([
      `:rotating_light: *[Triggered] ${scenario.monitor}*`,
      '',
      `*Service:* ${scenario.service} (${skin.company})`,
      `*Demo page:* https://devindemos.com/oncall/c/${skin.slug} — reproduce the symptom on this branded page`,
      `*Endpoint:* ${scenario.endpoint}`,
      `*Metric value:* ${scenario.metricValue} | *Threshold:* ${scenario.threshold} | *Baseline:* ${scenario.baseline}`,
      `*Monitor query:* \`${scenario.metricQuery}\``,
      `*Owner:* ${scenario.owner} — fictional on-call persona`,
      '*Incident Ref:* run-test',
      '',
      `Env: production | Release: ${scenario.release}`,
      `Events: 3 | First: ${firstSeen} | Last: ${NOW.toISOString()}`,
      '',
      `*Symptom:* ${scenario.symptom}`,
      `*Impact:* ${scenario.impact}`,
      'Repo: https://github.com/COG-GTM/event-driven-devin',
    ].join('\n'));
    expect(blocks).toContain(`[Triggered] ${scenario.monitor}`);
    expect(blocks).toContain(`Service: \`${scenario.service}\``);
    expect(blocks).toContain(scenario.release);
  });

  test('partial alertCard overrides only the given fields', async () => {
    const base = getOncallSkin('cb84fd21');
    const scenario = ALERT_SCENARIOS.banking;
    const { text } = await postCard({ ...base, alertCard: { service: 'custom-api', team: 'custom-oncall' } });

    expect(text).toContain('*Service:* custom-api (RBC Royal Bank)');
    expect(text).toContain('*Owner:* Jordan Patel (custom-oncall)');
    expect(text).toContain(`*[Triggered] ${scenario.monitor}*`);
    expect(text).toContain(`*Endpoint:* ${scenario.endpoint}`);
    expect(text).toContain(`Release: ${scenario.release}`);
    expect(text).toContain(`*Symptom:* ${scenario.symptom}`);
  });

  test('d7dd38ef reports insurance claim latency as a p95 metric, not a 5xx rate', async () => {
    const skin = getOncallSkin('d7dd38ef');
    expect(skin.vertical).toBe('insurance');
    const { text, blocks } = await postCard(skin);

    expect(text).toContain('*[Triggered] p95 latency — group benefits claim submissions*');
    expect(text).toContain('*Metric value:* 7.6s | *Threshold:* > 1.5s | *Baseline:* ~350ms (7-day p95)');
    expect(text).toContain('`p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/insurance/claim}`');
    expect(blocks).toContain('7.6s');
    for (const out of [text, blocks]) {
      expect(out).not.toMatch(/5xx|error rate|504 on/i);
    }
    for (const key of ['release', 'team', 'metricQuery']) {
      expect(skin.alertCard[key]).not.toMatch(new RegExp(skin.company, 'i'));
    }
  });
});
