/* global afterEach, beforeEach, describe, expect, jest, test */
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 'sec-1', url: 'https://app.devin.ai/sessions/sec-1' }),
}));

const { createDevinSession } = require('../app/services/devin-api');
const {
  scheduleSecuritySession, buildSecurityPrompt, CARELINK_FINDING, SECURITY_REPO,
} = require('../app/services/security-remediation-session');

describe('direct security remediation session', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    createDevinSession.mockClear();
    process.env.DEVIN_SERVICE_KEY_RATINGSDIRECT = 'rd-key';
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.DEVIN_SERVICE_KEY_RATINGSDIRECT;
  });

  test('creates the Carelink session in the presenter account after the delay', async () => {
    scheduleSecuritySession({ customer: 'ratingsdirect', devinUserId: 'user-1', devinOrgId: 'org-1' });
    expect(createDevinSession).not.toHaveBeenCalled();

    jest.advanceTimersByTime(59999);
    expect(createDevinSession).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await Promise.resolve();

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({ apiKey: 'rd-key', orgId: 'org-1', userId: 'user-1', repos: [SECURITY_REPO] });
    expect(prompt).toContain(CARELINK_FINDING.finding_id);
    expect(prompt).toContain('COG-GTM/demo-vulns-swarm');
  });

  test('prompt embeds the finding payload as JSON', () => {
    const prompt = buildSecurityPrompt();
    expect(prompt).toContain('"severity": "high"');
    expect(prompt).toContain(CARELINK_FINDING.file);
  });
});
