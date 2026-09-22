/* global beforeEach, describe, expect, jest, test */

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
  createDevinSession: jest.fn(),
}));

const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { postOncallAlert, ALERT_SCENARIOS } = require('../app/services/oncall');

describe('Gusto payroll release failure as an on-call alert (f8555891)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('scenario is branded, unlisted from the generic hub, and metric-shaped', () => {
    const scenario = ALERT_SCENARIOS.f8555891;
    expect(scenario.unlisted).toBe(true);
    expect(scenario.brand).toMatch(/Gusto/);
    expect(scenario.metricQuery).toContain('gusto_payroll.batch_release_failure');
    expect(`${scenario.symptom} ${scenario.impact}`).not.toMatch(/\.js|employerRate|TypeError/);
  });

  test('posts a monitor card to the alerts channel with the batch id as the incident ref', async () => {
    const result = await postOncallAlert('f8555891', { runRef: 'PB-2026-09-15-A' });

    expect(result).toMatchObject({ ok: true, channel: 'C0TEST' });
    expect(result.sessionUrl).toBeUndefined();
    expect(createDevinSession).not.toHaveBeenCalled();

    const [, channel, text, blocks] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    expect(text).toContain('[Triggered] Error rate — payroll batch ACH release');
    expect(text).toContain('*Incident Ref:* PB-2026-09-15-A');
    expect(text).toContain('/gusto — reproduce the symptom on this branded page');
    expect(text).not.toMatch(/\/oncall\/c\//);
    expect(JSON.stringify(blocks)).toContain('customer-f8555891-payroll (Gusto (Payroll Operations))');
  });
});
