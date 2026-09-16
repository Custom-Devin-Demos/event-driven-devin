const {
  ONCALL_UNASSIGNED_TEXT,
  buildAlertBlocks,
  onCallText,
} = require('../app/services/slack');

const RUSSELL = 'U08S7AVJ478';
const SHAWN = 'U08RSEMUV3L';

const ALERT = {
  title: 'StreamProfileError.unregisteredRig: No stream profile registered for rig class rtx5080',
  errorType: 'StreamProfileError.unregisteredRig',
  errorValue: 'No stream profile registered for rig class rtx5080',
  culprit: 'StreamProfiles.swift',
  level: 'error',
  environment: 'prod',
  project: 'geforce-now-ios',
  release: 'geforce-now-ios@1.0.0',
  platform: 'ios',
  issueUrl: 'https://sentry.example/issues/1',
  service: 'customer-315f52fe-ios',
  customer: '315f52fe',
  tags: [],
  extra: {},
};

function cardText(alertData) {
  return JSON.stringify(buildAlertBlocks(alertData));
}

describe('alert card On-Call owner', () => {
  const savedEnv = process.env.DEMO_ONCALL_SLACK_MEMBER_ID;
  const savedPersona = process.env.DEMO_ONCALL_PERSONA;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.DEMO_ONCALL_SLACK_MEMBER_ID;
    else process.env.DEMO_ONCALL_SLACK_MEMBER_ID = savedEnv;
    if (savedPersona === undefined) delete process.env.DEMO_ONCALL_PERSONA;
    else process.env.DEMO_ONCALL_PERSONA = savedPersona;
  });

  test('renders Unassigned and mentions nobody when the vertical names nobody', () => {
    delete process.env.DEMO_ONCALL_SLACK_MEMBER_ID;
    expect(ONCALL_UNASSIGNED_TEXT).toBe('_Unassigned_');
    expect(onCallText(undefined)).toBe(ONCALL_UNASSIGNED_TEXT);
    expect(onCallText('')).toBe(ONCALL_UNASSIGNED_TEXT);
    const text = cardText(ALERT);
    expect(text).toContain(`*On-Call:*\\n${ONCALL_UNASSIGNED_TEXT}`);
    expect(text).not.toContain(RUSSELL);
    expect(text).not.toMatch(/<@/);
  });

  test('mentions the member the vertical passed', () => {
    expect(onCallText(SHAWN)).toBe(`<@${SHAWN}>`);
    const text = cardText({ ...ALERT, slackMemberId: SHAWN });
    expect(text).toContain(`<@${SHAWN}>`);
    expect(text).not.toContain(RUSSELL);
  });

  test('never renders a made-up persona, even when one is configured', () => {
    process.env.DEMO_ONCALL_PERSONA = 'Riley Chen (platform-oncall)';
    delete process.env.DEMO_ONCALL_SLACK_MEMBER_ID;
    const text = cardText(ALERT);
    expect(text).not.toMatch(/Riley|persona|do not resolve/);
    expect(text).toContain(ONCALL_UNASSIGNED_TEXT);
  });

  test('rejects a malformed member id instead of injecting it into the card', () => {
    delete process.env.DEMO_ONCALL_SLACK_MEMBER_ID;
    expect(onCallText('<!channel>')).toBe(ONCALL_UNASSIGNED_TEXT);
    process.env.DEMO_ONCALL_SLACK_MEMBER_ID = '<!here>';
    expect(onCallText('')).toBe(ONCALL_UNASSIGNED_TEXT);
  });

  test('DEMO_ONCALL_SLACK_MEMBER_ID opts a deployment into a default real member', () => {
    process.env.DEMO_ONCALL_SLACK_MEMBER_ID = SHAWN;
    expect(onCallText(undefined)).toBe(`<@${SHAWN}>`);
    expect(onCallText(RUSSELL)).toBe(`<@${RUSSELL}>`);
  });
});
