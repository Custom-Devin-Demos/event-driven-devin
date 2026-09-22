jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const {
  lookupOrder,
  auditOrderAccess,
  findOrder,
  MEMBER_SESSIONS,
  PII_FIELDS,
} = require('../app/services/verticals/50b235c7');
const { runAudit } = require('../scripts/lululemon-authz-audit');

const OWN_ORDER = 'LLL-4472118';
const OTHER_ORDER = 'LLL-4471902';

beforeEach(() => {
  createSessionAndAlert.mockClear();
});

describe('order-status lookup', () => {
  it('serves a member their own order without raising a finding', async () => {
    const result = await lookupOrder({ orderNumber: OWN_ORDER, sessionToken: 'sess_demo_avery' });

    expect(result.crossAccount).toBe(false);
    expect(result.order.memberId).toBe(MEMBER_SESSIONS.sess_demo_avery.memberId);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('rejects an unknown order number', async () => {
    await expect(
      lookupOrder({ orderNumber: 'LLL-0000000', sessionToken: 'sess_demo_avery' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', statusCode: 404 });
  });

  it('rejects a request with no signed-in session', async () => {
    await expect(
      lookupOrder({ orderNumber: OWN_ORDER, sessionToken: 'sess_unknown' }),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED', statusCode: 401 });
  });

  // Planted defect: object-level authorization is missing, so the endpoint
  // succeeds and serves another member's record. Devin fixes this live.
  it('currently returns another member\'s order and alerts instead of denying', async () => {
    const result = await lookupOrder({ orderNumber: OTHER_ORDER, sessionToken: 'sess_demo_avery' });

    expect(result.crossAccount).toBe(true);
    expect(result.order.memberId).not.toBe(MEMBER_SESSIONS.sess_demo_avery.memberId);
    for (const field of PII_FIELDS) {
      expect(result.order[field]).toBeDefined();
    }

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('50b235c7');
    expect(alert.errorType).toBe('BrokenAccessControlError');
    expect(alert.tags).toContainEqual({ key: 'cwe', value: 'CWE-639' });
    expect(JSON.stringify(alert)).not.toContain(findOrder(OTHER_ORDER).email);
  });

  it('does not alert on audit probe traffic', async () => {
    await lookupOrder({ orderNumber: OTHER_ORDER, sessionToken: 'sess_demo_avery', audit: true });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('auditOrderAccess', () => {
  it('reports exposed field names, never values', () => {
    const order = findOrder(OTHER_ORDER);
    const access = auditOrderAccess(order, MEMBER_SESSIONS.sess_demo_avery);

    expect(access.violation).toBe(true);
    expect(access.exposedFields).toEqual(PII_FIELDS);
    expect(access.exposedFields).not.toContain(order.email);
  });
});

describe('authorization audit script', () => {
  it('detects the cross-account leak the endpoint still allows', async () => {
    const findings = await runAudit();

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]).toMatchObject({ leaked: true });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
