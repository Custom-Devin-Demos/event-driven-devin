jest.mock('../app/services/jira', () => ({
  isConfigured: jest.fn(() => true),
  getBaseUrl: jest.fn(() => 'https://jira.example'),
  issueUrl: jest.fn((k) => `https://jira.example/browse/${k}`),
  getIssue: jest.fn(),
  addComment: jest.fn().mockResolvedValue({ id: '1', url: 'https://jira.example/c/1' }),
  transitionTo: jest.fn().mockResolvedValue(true),
  assign: jest.fn().mockResolvedValue(true),
}));

jest.mock('../app/services/servicenow', () => ({
  isConfigured: jest.fn(() => true),
  createChangeRequest: jest.fn().mockResolvedValue({ number: 'CHG0001', sysId: 'sys1', url: 'https://sn.example/CHG0001' }),
  addChangeWorkNote: jest.fn().mockResolvedValue(true),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 's-1', url: 'https://app.devin.ai/sessions/s-1' }),
}));

jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const jira = require('../app/services/jira');
const servicenow = require('../app/services/servicenow');
const { createDevinSession } = require('../app/services/devin-api');
const gate = require('../app/services/verticals/eac595f3');

function issue(key, status, assignee = null) {
  return {
    key,
    url: `https://jira.example/browse/${key}`,
    summary: `Story ${key}`,
    status,
    assignee,
    reporter: { accountId: 'rep-1', displayName: 'Reporter' },
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  jira.isConfigured.mockReturnValue(true);
  jira.getIssue.mockImplementation(async (key) => issue(key, key === 'MBA-2553' ? 'In Progress' : 'Done'));
  await gate.resetDemo();
});

describe('evaluateBuild', () => {
  test('clean build is READY', () => {
    const build = gate.BUILDS['claims-adjudication-svc@4.12.0'];
    const result = gate.evaluateBuild(build, { 'MBA-2552': issue('MBA-2552', 'Done') });
    expect(result.verdict).toBe('READY');
    expect(result.failures).toHaveLength(0);
  });

  test('unapproved story and missing QA sign-off block the build with exact gaps', () => {
    const build = gate.BUILDS['member-portal-web@7.3.1'];
    const result = gate.evaluateBuild(build, { 'MBA-2553': issue('MBA-2553', 'In Progress') });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.failures.map((f) => f.id)).toEqual(['jira.MBA-2553.approved', 'meta.qaSignoff']);
    expect(result.failures[0].remediation).toMatch(/Move MBA-2553 to Done/);
  });

  test('unresolvable Jira key is a failed check, not a crash', () => {
    const build = gate.BUILDS['claims-adjudication-svc@4.12.0'];
    const result = gate.evaluateBuild(build, {});
    expect(result.verdict).toBe('BLOCKED');
    expect(result.failures[0].id).toBe('jira.MBA-2552.exists');
  });

  test('failed regression tests block the build', () => {
    const build = gate.BUILDS['eligibility-batch@11.0.2'];
    const result = gate.evaluateBuild(build, { 'MBA-2555': issue('MBA-2555', 'Done') });
    expect(result.failures.map((f) => f.id)).toEqual(['tests.regression']);
  });
});

describe('submitBuild', () => {
  test('READY build creates a ServiceNow change and comments the CHG on Jira', async () => {
    const result = await gate.submitBuild({ buildId: 'claims-adjudication-svc@4.12.0' });
    expect(result.verdict).toBe('READY');
    expect(result.change.number).toBe('CHG0001');
    expect(result.pipelineId).toMatch(/^XLR-/);
    expect(servicenow.createChangeRequest).toHaveBeenCalledWith(expect.objectContaining({
      backoutPlan: expect.stringContaining('Helm rollback'),
      correlationId: result.runId,
    }));
    expect(jira.addComment).toHaveBeenCalledWith('MBA-2552', expect.stringContaining('CHG0001'));
    expect(jira.transitionTo).not.toHaveBeenCalled();
    expect(gate.listBuilds().find((b) => b.id === 'claims-adjudication-svc@4.12.0').gate.status).toBe('ready');
  });

  test('BLOCKED build writes the exact gap to Jira, pulls the story back and assigns the owner', async () => {
    const result = await gate.submitBuild({ buildId: 'pharmacy-benefits-api@2.8.0' });
    expect(result.verdict).toBe('BLOCKED');
    expect(servicenow.createChangeRequest).not.toHaveBeenCalled();
    expect(jira.addComment).toHaveBeenCalledWith('MBA-2554', expect.stringContaining('Rollback plan present'));
    expect(jira.transitionTo).toHaveBeenCalledWith('MBA-2554', 'In Progress');
    expect(jira.assign).toHaveBeenCalledWith('MBA-2554', 'rep-1');
    expect(result.actions.map((a) => a.action)).toEqual(['comment', 'transition', 'assign']);
  });

  test('story already in progress is not transitioned again', async () => {
    await gate.submitBuild({ buildId: 'member-portal-web@7.3.1' });
    expect(jira.transitionTo).not.toHaveBeenCalled();
  });

  test('optional Devin session is created only for blocked builds when requested', async () => {
    process.env.DEVIN_SERVICE_KEY = 'test-key';
    const result = await gate.submitBuild({ buildId: 'eligibility-batch@11.0.2', triggerDevin: true, devinUserId: 'u1', devinOrgId: 'o1' });
    delete process.env.DEVIN_SERVICE_KEY;
    expect(createDevinSession).toHaveBeenCalledWith(expect.stringContaining('ELG-REG-9'), expect.objectContaining({ userId: 'u1', orgId: 'o1' }));
    expect(result.devinSession.sessionId).toBe('s-1');
  });

  test('unknown build is a 404', async () => {
    await expect(gate.submitBuild({ buildId: 'nope' })).rejects.toMatchObject({ status: 404 });
  });

  test('works without Jira configured (checks fail closed)', async () => {
    jira.isConfigured.mockReturnValue(false);
    const result = await gate.submitBuild({ buildId: 'claims-adjudication-svc@4.12.0' });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.actions).toEqual([{ system: 'jira', action: 'skipped', detail: 'Jira not configured' }]);
  });
});

describe('remediate → resubmit', () => {
  test('developer correction flips a blocked build to READY on resubmit', async () => {
    let status = 'Done';
    jira.getIssue.mockImplementation(async (key) => issue(key, status));
    jira.transitionTo.mockImplementation(async (_key, to) => { status = to; return true; });

    const first = await gate.submitBuild({ buildId: 'eligibility-batch@11.0.2' });
    expect(first.verdict).toBe('BLOCKED');
    expect(status).toBe('In Progress');

    const fix = await gate.remediateBuild('eligibility-batch@11.0.2');
    expect(fix.applied).toEqual(['Regression suite ELG-REG-9 re-run green', 'MBA-2555 approved (→ Done)']);

    const second = await gate.submitBuild({ buildId: 'eligibility-batch@11.0.2' });
    expect(second.verdict).toBe('READY');
    expect(gate.getAudit().map((a) => a.event)).toEqual([
      'gate.ready', 'build.submitted', 'build.corrected', 'gate.blocked', 'build.submitted',
    ]);
  });

  test('resetDemo restores seeded evidence and Jira statuses', async () => {
    await gate.remediateBuild('pharmacy-benefits-api@2.8.0');
    jira.getIssue.mockImplementation(async (key) => issue(key, 'Done'));
    const { jiraReset } = await gate.resetDemo();
    expect(gate.BUILDS['pharmacy-benefits-api@2.8.0'].metadata.rollbackPlan).toBe('');
    expect(jiraReset).toEqual(['MBA-2553 → In Progress']);
    expect(gate.getAudit()).toHaveLength(0);
  });
});
