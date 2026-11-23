jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve()),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const {
  getDashboard, runValidation, rowCountCheck, summariseValidation, resetAlertCooldown,
} = require('../app/services/verticals/c0e5ab62');
const { TABLES } = require('../pipelines/c0e5ab62/migrate');

describe('billing migration validation (c0e5ab62)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    resetAlertCooldown();
  });

  test('the committed migration run copied about 100,000 rows and reports completed', () => {
    const { migration, rowCounts } = getDashboard();
    expect(migration.status).toBe('completed');
    expect(rowCounts.sourceRows).toBe(100000);
    expect(rowCounts.tables.map((t) => t.table)).toEqual(TABLES.map((t) => t.name));
  });

  test('row-count drift raises one alert per cooldown window, with no cause in the alert', async () => {
    const first = await runValidation({});
    expect(first).toMatchObject({ status: 'drift', alerted: true });
    expect(first.drift.map((d) => d.table).sort()).toEqual(['accounts', 'invoices']);

    const second = await runValidation({});
    expect(second).toMatchObject({ status: 'drift', alerted: false, cooldown: true });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('c0e5ab62');
    expect(`${alert.issueTitle} ${alert.errorValue}`).not.toMatch(/duplicate|truncat|time ?zone|round|encoding|charset/i);
  });

  test('reports off runs the check without alerting', async () => {
    const result = await runValidation({ reportsOff: true });
    expect(result).toMatchObject({ status: 'drift', alerted: false });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('matching counts report a match', () => {
    const counts = { customers: 1, accounts: 2, invoices: 3 };
    expect(rowCountCheck({ rowCounts: { source: counts, target: counts } }).drift).toEqual([]);
  });

  test('validation summary measures first run to zero differences', () => {
    const summary = summariseValidation({
      runs: [
        { runAt: '2026-01-01T10:00:00.000Z', totalDifferences: 12, causes: [{ id: 'a' }, { id: 'b' }] },
        { runAt: '2026-01-01T10:20:00.000Z', totalDifferences: 0, causes: [] },
      ],
    });
    expect(summary).toMatchObject({ differencesFound: 12, causesIdentified: 2, remaining: 0, msToZero: 20 * 60 * 1000 });
    expect(summariseValidation(null)).toBeNull();
  });
});
