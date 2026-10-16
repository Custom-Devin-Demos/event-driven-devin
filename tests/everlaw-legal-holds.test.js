/* global afterAll, beforeEach, describe, expect, jest, test */

const { setImmediate } = require('timers');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/linear', () => ({
  createLinearIssue: jest.fn().mockResolvedValue(null),
  addLinearComment: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/slack', () => ({
  postLinearIssueLink: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const {
  createLinearIssue,
  addLinearComment,
} = require('../app/services/linear');
const { postLinearIssueLink } = require('../app/services/slack');
const { Sentry } = require('../app/telemetry/sentry');
const {
  CUSTODIANS,
  RELEASE_NOTICE_TEMPLATES,
  releaseCustodians,
  REMEDIATION_DIRECTIVE,
  LINEAR_STATE_IN_PROGRESS_ID,
  LINEAR_STATE_IN_REVIEW_ID,
} = require('../app/services/verticals/d2dd4b8e');

const SLUG = 'd2dd4b8e';
const HOLD_NOTICE_ID = 'hold-notice-1';
const originalSlackChannelId = process.env.SLACK_CHANNEL_ID_D2DD4B8E;
const seededCustodians = structuredClone(CUSTODIANS);

describe('Everlaw legal holds service (d2dd4b8e)', () => {
  afterAll(() => {
    if (originalSlackChannelId === undefined) delete process.env.SLACK_CHANNEL_ID_D2DD4B8E;
    else process.env.SLACK_CHANNEL_ID_D2DD4B8E = originalSlackChannelId;
    CUSTODIANS.splice(0, CUSTODIANS.length, ...structuredClone(seededCustodians));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SLACK_CHANNEL_ID_D2DD4B8E;
    CUSTODIANS.splice(0, CUSTODIANS.length, ...structuredClone(seededCustodians));
    createLinearIssue.mockResolvedValue(null);
    createSessionAndAlert.mockResolvedValue(null);
    addLinearComment.mockResolvedValue(null);
    postLinearIssueLink.mockResolvedValue(null);
  });

  async function flushAsyncWork() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  test('releases a custodian whose notice template is available', async () => {
    const previousStatus = CUSTODIANS[0].acknowledgementStatus;
    CUSTODIANS[0].acknowledgementStatus = 'acknowledged';

    try {
      const result = await releaseCustodians({
        holdNoticeId: HOLD_NOTICE_ID,
        custodianIds: [CUSTODIANS[0].id],
      });

      expect(result.success).toBe(true);
      expect(result.releasedCustodians).toHaveLength(1);
      expect(result.releasedCustodians[0]).toMatchObject({
        id: CUSTODIANS[0].id,
        holdStatus: 'released',
        notices: [{ subject: RELEASE_NOTICE_TEMPLATES.acknowledged.subject }],
      });
      expect(CUSTODIANS[0].holdStatus).toBe('issued');
    } finally {
      CUSTODIANS[0].acknowledgementStatus = previousStatus;
    }
  });

  test('fails atomically for release-all and raises the app-direct alert once', async () => {
    const before = structuredClone(CUSTODIANS);
    await expect(releaseCustodians({ holdNoticeId: HOLD_NOTICE_ID })).rejects.toThrow(
      "Cannot read properties of undefined (reading 'subject')",
    );
    await flushAsyncWork();

    expect(CUSTODIANS).toEqual(before);
    expect(CUSTODIANS.every((custodian) => custodian.holdStatus === 'issued')).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: SLUG,
      service: `customer-${SLUG}-legal-holds`,
      culprit: `app/services/verticals/${SLUG}.js — buildReleaseNotice`,
      verticalLabel: 'Everlaw Legal Holds — Release Custodians',
    });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Everlaw legal hold custodian release failing',
      severity: 'SEV-2',
      service: `customer-${SLUG}-legal-holds`,
    }));
    expect(createLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/^\[Everlaw legal holds\] TypeError:/),
      assigneeId: '4d616028-0c12-4ad9-b117-0661170e857e',
      stateId: LINEAR_STATE_IN_PROGRESS_ID,
    }));
    expect(createLinearIssue.mock.calls[0][0].description).toContain(`POST /api/${SLUG}/release-custodians`);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags.service).toBe(`customer-${SLUG}-legal-holds`);
  });

  test('comments the session link and posts the ticket link using the configured channel', async () => {
    const issue = {
      id: 'iss_1',
      identifier: 'COG-9999',
      url: 'https://linear.app/cog-gtm/issue/COG-9999',
    };
    createLinearIssue.mockResolvedValue(issue);
    createSessionAndAlert.mockResolvedValue({
      triggered: true,
      throttled: false,
      threadTs: '1.2',
      session: { sessionId: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' },
    });
    process.env.SLACK_CHANNEL_ID_D2DD4B8E = 'C_EVERLAW';

    await expect(releaseCustodians({ holdNoticeId: HOLD_NOTICE_ID })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(createLinearIssue).toHaveBeenCalledWith(expect.objectContaining({
      stateId: '99c9b96f-39b3-4a09-9112-53c054f3dbab',
    }));
    expect(createSessionAndAlert.mock.calls[0][0].promptAppendix).toContain('COG-9999');
    expect(createSessionAndAlert.mock.calls[0][0].promptAppendix).toContain('In Review');
    expect(createSessionAndAlert.mock.calls[0][0].promptAppendix).toContain('Do NOT move the ticket to Done');
    expect(addLinearComment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: issue.id,
      body: expect.stringContaining('https://app.devin.ai/sessions/abc'),
    }));
    expect(postLinearIssueLink).toHaveBeenCalledWith('1.2', issue, 'C_EVERLAW');
  });

  test('posts the ticket link when the session comment fails and channel is unset', async () => {
    const issue = { id: 'iss_1', identifier: 'COG-9999', url: 'https://linear.app/issue/COG-9999' };
    createLinearIssue.mockResolvedValue(issue);
    createSessionAndAlert.mockResolvedValue({
      triggered: true,
      threadTs: '1.2',
      session: { sessionId: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' },
    });
    addLinearComment.mockRejectedValueOnce(new Error('comment unavailable'));

    await expect(releaseCustodians({ holdNoticeId: HOLD_NOTICE_ID })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(addLinearComment).toHaveBeenCalled();
    expect(postLinearIssueLink).toHaveBeenCalledWith('1.2', issue, undefined);
  });

  test('posts the ticket link when no session was created', async () => {
    const issue = { id: 'iss_1', identifier: 'COG-9999', url: 'https://linear.app/issue/COG-9999' };
    createLinearIssue.mockResolvedValue(issue);
    createSessionAndAlert.mockResolvedValue({
      triggered: false,
      throttled: true,
      threadTs: '1.2',
      session: null,
    });

    await expect(releaseCustodians({ holdNoticeId: HOLD_NOTICE_ID })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(postLinearIssueLink).toHaveBeenCalledWith('1.2', issue, undefined);
    expect(addLinearComment).not.toHaveBeenCalled();
  });

  test('uses the base directive and skips Linear follow-up when issue creation fails', async () => {
    createSessionAndAlert.mockResolvedValue({
      triggered: true,
      threadTs: '1.2',
      session: { sessionId: 'devin-abc', url: 'https://app.devin.ai/sessions/abc' },
    });

    await expect(releaseCustodians({ holdNoticeId: HOLD_NOTICE_ID })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(createSessionAndAlert.mock.calls[0][0].promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(addLinearComment).not.toHaveBeenCalled();
    expect(postLinearIssueLink).not.toHaveBeenCalled();
  });

  test.each([
    [{ holdNoticeId: 'missing-notice' }, 'UNKNOWN_HOLD_NOTICE'],
    [{ holdNoticeId: HOLD_NOTICE_ID, custodianIds: ['missing-custodian'] }, 'UNKNOWN_CUSTODIAN'],
  ])('rejects invalid input without alerting: %j', async (data, code) => {
    await expect(releaseCustodians(data)).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code,
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(createLinearIssue).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('has three seeded unacknowledged custodians', () => {
    expect(CUSTODIANS).toHaveLength(3);
    expect(CUSTODIANS.map(({ acknowledgementStatus }) => acknowledgementStatus)).toEqual([
      'not_acknowledged',
      'not_acknowledged',
      'not_acknowledged',
    ]);
    expect(CUSTODIANS.every(({ communicationHistory }) => communicationHistory.length > 0)).toBe(true);
    expect(LINEAR_STATE_IN_PROGRESS_ID).toBe('99c9b96f-39b3-4a09-9112-53c054f3dbab');
    expect(LINEAR_STATE_IN_REVIEW_ID).toBe('d79ea314-a400-4382-9140-d4861fb4e30f');
  });
});
