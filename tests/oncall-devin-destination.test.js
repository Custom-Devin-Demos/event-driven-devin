jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(),
}));
jest.mock('../app/services/slack', () => ({
  ...jest.requireActual('../app/services/slack'),
  postMessage: jest.fn(),
  postThreadReply: jest.fn(),
}));

const { createDevinSession } = require('../app/services/devin-api');
const { postMessage, postThreadReply } = require('../app/services/slack');
const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

const ENV_KEYS = ['DEVIN_ONCALL_SERVICE_KEY', 'DEVIN_SERVICE_KEY', 'DEVIN_API_KEY', 'SLACK_ONCALL_ALERTS_CHANNEL_ID', 'SLACK_ONCALL_BOT_TOKEN', 'SLACK_BOT_TOKEN'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
  process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
  jest.clearAllMocks();
  if (resetSkinAlertMemory) resetSkinAlertMemory();
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
});

describe("alertDestination: 'devin' skins", () => {
  const skin = getOncallSkin('b4fb2968');

  test('start a Devin session as the pinned user and post no Slack card', async () => {
    process.env.DEVIN_ONCALL_SERVICE_KEY = 'svc-test';
    createDevinSession.mockResolvedValue({ sessionId: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' });

    const result = await postOncallAlert('coveragecheck', {
      skin, devinEmail: 'someone@example.com', devinOrgId: 'org_other', devinUserId: 'email|other',
    });

    expect(result).toMatchObject({ ok: true, devin: true, sessionUrl: 'https://app.devin.ai/sessions/abc' });
    expect(result.runRef).toEqual(expect.any(String));
    expect(postMessage).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({
      orgId: 'org_69IXJFLrljx8zSAw', userId: 'email|698b4ec82a96a7c11bae5936', apiKey: 'svc-test',
    });
    expect(prompt).toContain('Pomelo Care signup');
    expect(prompt).not.toContain('Slack Thread:');
  });

  test('repeat failures inside the window share the first session', async () => {
    process.env.DEVIN_ONCALL_SERVICE_KEY = 'svc-test';
    let finish;
    createDevinSession.mockImplementation(() => new Promise((r) => { finish = r; }));

    const first = postOncallAlert('coveragecheck', { skin });
    const second = postOncallAlert('coveragecheck', { skin });
    finish({ sessionId: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' });
    const [a, b] = await Promise.all([first, second]);
    const c = await postOncallAlert('coveragecheck', { skin });

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ ok: true, sessionUrl: 'https://app.devin.ai/sessions/abc' });
    [b, c].forEach((r) => expect(r).toMatchObject({ ok: true, repeat: true, sessionUrl: 'https://app.devin.ai/sessions/abc', runRef: a.runRef }));
  });

  test('an explicit runRef starts its own session instead of joining', async () => {
    process.env.DEVIN_ONCALL_SERVICE_KEY = 'svc-test';
    createDevinSession.mockResolvedValueOnce({ sessionId: 'devin-a', url: 'https://app.devin.ai/sessions/a' })
      .mockResolvedValueOnce({ sessionId: 'devin-b', url: 'https://app.devin.ai/sessions/b' });
    await postOncallAlert('coveragecheck', { skin });
    const explicit = await postOncallAlert('coveragecheck', { skin, runRef: 'run-bbb' });
    expect(explicit).toMatchObject({ ok: true, runRef: 'run-bbb', sessionUrl: 'https://app.devin.ai/sessions/b' });
    expect(explicit.repeat).toBeUndefined();
  });

  test('a failed session start does not block the next attempt', async () => {
    process.env.DEVIN_ONCALL_SERVICE_KEY = 'svc-test';
    createDevinSession.mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sessionId: 'devin-def', url: 'https://app.devin.ai/sessions/def' });
    expect(await postOncallAlert('coveragecheck', { skin })).toMatchObject({ ok: false, devin: true });
    expect(await postOncallAlert('coveragecheck', { skin })).toMatchObject({ ok: true, sessionUrl: 'https://app.devin.ai/sessions/def' });
    expect(createDevinSession).toHaveBeenCalledTimes(2);
  });

  test('skip cleanly when no Devin service key is configured', async () => {
    const result = await postOncallAlert('coveragecheck', { skin });
    expect(result).toMatchObject({ ok: false, skipped: true, devin: true });
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  test('report a failure when the session API returns nothing', async () => {
    process.env.DEVIN_ONCALL_SERVICE_KEY = 'svc-test';
    createDevinSession.mockResolvedValue(null);
    const result = await postOncallAlert('coveragecheck', { skin });
    expect(result).toMatchObject({ ok: false, devin: true });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
