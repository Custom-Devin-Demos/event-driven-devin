jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  recordDecision,
  getDecisionRecord,
  getReviewQueue,
  getExceptionRegister,
  CI_NAME,
} = require('../app/services/verticals/c6e2a88f');
const { SUBMISSIONS } = require('../app/services/verticals/c6e2a88f-submissions');
const customer = require('../config/customers/c6e2a88f');

describe('Cigna Enterprise Architecture — Architecture Review Hub (c6e2a88f)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('the customer is routed to ServiceNow for the EA platform team', () => {
    expect(customer.itsm).toBe('servicenow');
    expect(customer.itsmAssignmentGroup).toBe('Enterprise Architecture Platform Engineering');
    expect(customer.aliases).toEqual(expect.arrayContaining(['arb-hub', 'architecture-review-hub']));
  });

  test('the review queue and exception register use the board vocabulary', () => {
    const queue = getReviewQueue();
    expect(queue.rows).toHaveLength(7);
    expect(queue.rows.map((r) => r.status)).toEqual(expect.arrayContaining(['Waiting on me', 'In review', 'Board scheduled', 'Overdue', 'Decided']));
    expect(queue.rows.find((r) => r.reference === 'ARB-2026-0151').catalogueVersion).toBe('2026.4');

    const register = getExceptionRegister();
    expect(register.rows).toHaveLength(8);
    expect(register.rows.map((r) => r.status)).toEqual(expect.arrayContaining(['Active', 'Expiring', 'Review overdue']));
    register.rows.forEach((row) => {
      expect(row).toEqual(expect.objectContaining({ owner: expect.any(String), compensatingControl: expect.any(String), reviewDate: expect.any(String), expiresAt: expect.any(String) }));
    });
  });

  test('a decided submission returns its published ADR', () => {
    const record = getDecisionRecord('ARB-2026-0142');
    expect(record.decision.id).toBe('ADR-2026-031');
    expect(record.decision.outcome).toBe('Approved with conditions');
    expect(record.decision.linkedExceptions[0].id).toBe('EXC-2026-018');
  });

  test('an unknown submission is rejected without raising an incident', async () => {
    await expect(recordDecision({ reference: 'ARB-2026-9999', outcome: 'Approved' })).rejects.toMatchObject({
      name: 'SubmissionNotFoundError',
      statusCode: 404,
      code: 'SUBMISSION_NOT_FOUND',
    });
    await expect(recordDecision({ reference: 'ARB-2026-0144', outcome: 'Maybe' })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a decision on a submission pinned before the catalogue-versioning release is recorded', async () => {
    const result = await recordDecision({
      reference: 'ARB-2026-0144',
      outcome: 'Approved with conditions',
      conditions: ['Retention store classified and encrypted (DAT-011)'],
      standards: ['DAT-011', 'CLD-004'],
    });
    expect(result.success).toBe(true);
    expect(result.decision.id).toMatch(/^ADR-2026-\d{3}$/);
    expect(result.decision.catalogueVersion).toBe('2026.3');
    expect(result.decision.standards).toEqual(['DAT-011 v5 (catalogue 2026.3)', 'CLD-004 v3 (catalogue 2026.3)']);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('every submission except those on catalogue 2026.4 records cleanly', async () => {
    const legacy = SUBMISSIONS.filter((s) => s.catalogueVersion.label !== '2026.4');
    expect(legacy.length).toBeGreaterThan(0);
    for (const submission of legacy) {
      const result = await recordDecision({ reference: submission.reference, outcome: 'Approved' });
      expect(result.success).toBe(true);
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('Record decision fails with a TypeError for a submission pinned to the new catalogue 2026.4', async () => {
    await expect(recordDecision({
      reference: 'ARB-2026-0151',
      outcome: 'Approved with conditions',
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
    })).rejects.toMatchObject({ name: 'TypeError' });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('c6e2a88f');
    expect(alert.service).toBe(CI_NAME);
    expect(alert.title).toContain('Architecture Review Hub');
    expect(alert.title).toContain('catalogue 2026.4');
    expect(alert.issueTitle).toMatch(/^TypeError: /);
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('standardsVersion');
    expect(alert.promptAppendix).toContain('catalogueVersion');
    expect(alert.promptAppendix).toContain('Do not deploy and do not close or resolve the incident');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'reference', value: 'ARB-2026-0151' },
      { key: 'catalogueVersion', value: '2026.4' },
    ]));
    expect(alert.devinUserId).toBe('user-1');
    expect(alert.slackMemberId).toBeTruthy();
  });

  test('the hub holds no member or patient data', () => {
    const blob = JSON.stringify(require('../app/services/verticals/c6e2a88f-submissions'));
    expect(blob).not.toMatch(/\b(member id|patient|date of birth|dob|ssn|mrn|diagnosis)\b/i);
  });
});
