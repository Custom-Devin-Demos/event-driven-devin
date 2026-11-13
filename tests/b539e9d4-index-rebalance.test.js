jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({
  ...jest.requireActual('../app/services/devin-session'),
  createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'devin-test' })),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const Sentry = require('@sentry/node');
const { createSessionAndAlert, buildPrompt } = require('../app/services/devin-session');
const svc = require('../app/services/verticals/b539e9d4');
const { normalizeTicker, resolveSecurity } = require('../app/services/verticals/b539e9d4-security-master');
const { getCustomerConfig, listAliases } = require('../config/customers');

beforeEach(() => {
  jest.clearAllMocks();
  svc.resetRebalance();
});

describe('S&P index rebalance registration', () => {
  test('registers the slug and friendly aliases', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(listAliases()['sp-index-rebalance']).toBe('b539e9d4');
    expect(listAliases()['index-rebalance']).toBe('b539e9d4');
  });

  test('page sends the Devin identity and is not listed on the hub', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/b539e9d4.html'), 'utf8');
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(html).toContain(key);
    expect(html).toContain("API + '/rebalance'");
    expect(fs.readFileSync(path.join(__dirname, '../app/public/hub.html'), 'utf8')).not.toMatch(/index-rebalance|b539e9d4/);
  });
});

describe('security master', () => {
  test('strips venue suffixes', () => {
    expect(normalizeTicker('PNCL.OQ')).toBe('PNCL');
    expect(normalizeTicker('hlvr.n')).toBe('HLVR');
    expect(resolveSecurity('BWTR').cusip).toBe('10921B106');
  });
});

describe('pre-open rebalance', () => {
  test('calendar puts the open after the announcement on a weekday', () => {
    const cal = svc.calendar(new Date('2026-11-13T23:30:00Z'));
    expect(cal).toEqual({ announcedDate: '2026-11-13', effectiveDate: '2026-11-16', marketOpenAt: '2026-11-16T14:30:00.000Z' });
    expect(svc.calendar(new Date('2026-07-01T22:00:00Z')).marketOpenAt).toBe('2026-07-02T13:30:00.000Z');
    expect(svc.calendar(new Date('2026-11-25T23:00:00Z')).effectiveDate).toBe('2026-11-27');
  });

  test('Sentry issue webhooks treat the rebalance as an instant-path alert', () => {
    const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/b539e9d4.js — runRebalance', tags: [] })).toBe(true);
  });

  // Planted defect: KSTL.B resolves to the Class A line. Devin's fix PR flips this to a passing release.
  test('holds the client feed when the S&P 500 add resolves to the wrong share class', async () => {
    await expect(svc.runRebalance({ devinOrgId: 'org-x', devinEmail: 'se@example.com' })).rejects.toMatchObject({ name: 'ConstituentMismatchError' });

    const { feed, status, lastError, notices } = svc.getOverview();
    expect(status).toBe('held');
    expect(feed.status).toBe('held');
    expect(lastError).toMatchObject({ noticeId: 'SPX-26-117', ticker: 'KSTL.B', stage: 'Reconcile vs. notices' });
    const kstl = feed.lines.find((line) => line.ticker === 'KSTL.B');
    expect(kstl).toMatchObject({ cusip: '48800A101', announcedCusip: '48800A200', check: 'mismatch' });
    expect(notices.find((n) => n.noticeId === 'SPX-26-117').status).toBe('mismatch');

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: 'b539e9d4', devinOrgId: 'org-x', devinEmail: 'se@example.com' });
    const prompt = buildPrompt(alert);
    expect(prompt).toContain('failing Jest test');
    expect(prompt).toContain('Do not merge; a human approves.');
  });

  test('synthetic runs skip the Devin alert', async () => {
    await expect(svc.runRebalance({ synthetic: true })).rejects.toThrow('SPX-26-117');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('MidCap 400 and SmallCap 600 changes reconcile against their notices', () => {
    for (const noticeId of ['MID-26-089', 'SML-26-142']) {
      const notice = svc.NOTICES.find((n) => n.noticeId === noticeId);
      expect(resolveSecurity(notice.add.ticker).cusip).toBe(notice.add.cusip);
    }
  });
});
