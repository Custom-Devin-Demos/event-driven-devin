/* global expect, test */

const { formatDigest } = require('../scripts/patrol-digest');

function issue(id, title = 'Track query') {
  return { id, url: `https://linear.app/acme/${id}`, title };
}

function base(overrides = {}) {
  return {
    mode: 'PRODUCTION',
    window: '2026-08-17 21:35 to 2026-08-18 01:40 UTC',
    windowNote: 'Datadog logs complete for the measured window.',
    rows: [
      { query: 'inventory.stock_by_sku', execs: 14640, mean: 12.02, p95: 18.36, total: 175.95 },
      { query: 'orders.line_items_scan', execs: 1560, mean: 47.16, p95: 59.75, total: 73.57 },
      { query: 'ledger.full_scan', execs: 54, mean: 1065.91, p95: 1200.13, total: 57.56 },
    ],
    filed: [issue('PAT-8', 'Inventory scan')].map((entry) => ({
      ...entry,
      url: 'https://linear.app/acme/issue/PAT-8',
    })),
    alreadyTracked: [],
    fix: { pr: 'PR #4726', url: 'https://github.com/acme/repo/pull/4726', summary: 'Add the inventory index.' },
    ...overrides,
  };
}

test('keeps columns aligned when values have different widths', () => {
  const digest = formatDigest(base({
    rows: [
      { query: 'short', execs: 1, mean: 0.0042, p95: 0.0084, total: 0.01 },
      { query: 'a-much-longer-query-name', execs: 1234567, mean: 1234.56, p95: 2345.67, total: 12345.67 },
    ],
  }));
  const table = digest.split('\n').slice(3, 6);
  const meanUnitStarts = table.slice(1).map((line) => line.indexOf('ms'));
  const totalUnitStarts = table.slice(1).map((line) => line.lastIndexOf('s'));
  expect(new Set(meanUnitStarts).size).toBe(1);
  expect(new Set(totalUnitStarts).size).toBe(1);
});

test('describes a mean leader that ranks lower on total time', () => {
  const digest = formatDigest(base());
  expect(digest).toContain(
    'A slowest-query-first view would have picked ledger.full_scan at 1,065.91 ms. It ranks 3 on total time.',
  );
});

test('describes agreeing total and mean leaders', () => {
  const digest = formatDigest(base({
    rows: [
      { query: 'same.query', execs: 100, mean: 12, p95: 18, total: 100 },
      { query: 'other.query', execs: 10, mean: 4, p95: 7, total: 2 },
    ],
  }));
  expect(digest).toContain(
    'The same query leads on total time and on mean per execution, so the two orderings agree.',
  );
});

test('rejects markdown links in supplied strings', () => {
  expect(() => formatDigest(base({ windowNote: '[bad](https://example.com)' }))).toThrow(/windowNote/);
});

test('rejects em dashes in supplied strings', () => {
  expect(() => formatDigest(base({ windowNote: 'Complete — no gaps.' }))).toThrow(/windowNote/);
});

test('prints none for empty already-tracked issues', () => {
  expect(formatDigest(base())).toContain('*Already tracked:* none');
});

test('omits the fix group when fix is null', () => {
  expect(formatDigest(base({ fix: null }))).not.toContain('*Fix:*');
});

test('preserves a sub-millisecond mean instead of printing zero', () => {
  const digest = formatDigest(base({
    rows: [{ query: 'fast.query', execs: 2, mean: 0.0042, p95: 0.0084, total: 0.01 }],
  }));
  expect(digest).toContain('0.0042 ms');
  expect(digest).not.toContain('0.00 ms');
});

test('prints the backtest project only for backtests', () => {
  const backtest = formatDigest(base({ mode: 'BACKTEST', backtestProject: 'patrol-backtest-2026-08-18-0140' }));
  expect(backtest).toContain('(project: patrol-backtest-2026-08-18-0140)');
  expect(formatDigest(base())).not.toContain('(project:');
});
