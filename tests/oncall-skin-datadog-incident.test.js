/* global afterEach, beforeEach, describe, expect, jest, test */

jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 's', url: 'https://app.devin.ai/sessions/s' }),
}));

jest.mock('../app/services/sonar-pr-trigger', () => ({
  scheduleVulnerablePR: jest.fn(),
}));

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn().mockResolvedValue({ id: 'inc-1', publicId: 1 }),
}));

const { postMessage } = require('../app/services/slack');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { getOncallSkin } = require('../config/oncall-skins');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { postOncallAlert, ALERT_SCENARIOS } = require('../app/services/oncall');

const BASE_SKIN = getOncallSkin('cb84fd21');

describe('per-skin Datadog incident on the on-call alert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a skin with datadogIncident declares a SEV-2 Datadog incident alongside the alert card', async () => {
    const skin = { ...BASE_SKIN, datadogIncident: true };
    const result = await postOncallAlert(skin.vertical, { skin, runRef: 'run-test', devinEmail: 'demo@devindemos.com' });

    expect(result.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    const scenario = ALERT_SCENARIOS[skin.vertical];
    expect(declareDatadogIncident.mock.calls[0][0]).toMatchObject({
      title: `${skin.company}: ${scenario.monitor}`,
      runRef: 'run-test',
      service: scenario.service,
      triggeredBy: 'demo@devindemos.com',
      severity: 'SEV-2',
    });
    expect(declareDatadogIncident.mock.calls[0][0].summary).toContain(scenario.symptom);
  });

  test('the United MileagePlus skin opts in', () => {
    expect(getOncallSkin('ddfc5af1').datadogIncident).toBe(true);
  });

  test('skins without datadogIncident do not touch Datadog Incident Management', async () => {
    expect(BASE_SKIN.datadogIncident).toBeUndefined();
    await postOncallAlert(BASE_SKIN.vertical, { skin: BASE_SKIN, runRef: 'run-test' });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });

  test('non-unique runs post the alert without opening an incident', async () => {
    const skin = { ...BASE_SKIN, datadogIncident: true };
    const result = await postOncallAlert(skin.vertical, { skin, unique: false });
    expect(result.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });

  test('a failed incident declaration does not fail the alert', async () => {
    declareDatadogIncident.mockRejectedValueOnce(new Error('403'));
    const skin = { ...BASE_SKIN, datadogIncident: true };
    const result = await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
    expect(result.ok).toBe(true);
  });
});
