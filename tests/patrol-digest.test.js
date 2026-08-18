/* global expect, test */

const { formatDigest, formatDuration } = require('../scripts/patrol-digest');

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
    fix: {
      pr: 'PR #4726',
      url: 'https://github.com/acme/repo/pull/4726',
      summary: 'Add the inventory index.',
      merged: false,
    },
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
  expect(digest).not.toContain('—');
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

test('rejects newlines in pasted copy and control characters in issue URLs', () => {
  expect(() => formatDigest(base({ windowNote: 'Complete\nwith gaps.' }))).toThrow(/windowNote/);
  expect(() => formatDigest(base({ windowNote: 'Complete <with> gaps.' }))).toThrow(/windowNote/);
  expect(() => formatDigest(base({
    filed: [{ ...base().filed[0], url: 'https://linear.app/acme/issue/PAT-8|broken' }],
  }))).toThrow(/filed\[0\]\.url/);
});

test('allows measured identifiers with prose banned words but rejects them in authored copy', () => {
  expect(formatDigest(base({
    rows: [{ ...base().rows[0], query: 'alerts.critical.by_service' }],
  }))).toContain('alerts.critical.by_service');
  expect(() => formatDigest(base({
    fix: { ...base().fix, summary: 'Fix the critical scan.' },
  }))).toThrow(/fix\.summary/);
});

test('prints none for empty already-tracked issues', () => {
  expect(formatDigest(base())).toContain('*Already tracked:* none');
});

test('omits the fix group when fix is null', () => {
  expect(formatDigest(base({ fix: null }))).not.toContain('*Fix:*');
});

test('renders merged and unmerged fix states without em dashes', () => {
  expect(formatDigest(base())).toContain('Not merged.');
  expect(formatDigest(base({
    fix: { ...base().fix, merged: true },
  }))).toContain('Merged.');
  expect(formatDigest(base())).not.toContain('—');
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
  expect(backtest).toMatch(/PAT-8>:[\s\S]*\(project: patrol-backtest-2026-08-18-0140\)/);
  expect(formatDigest(base())).not.toContain('(project:');
});

test('requires a complete fix summary sentence', () => {
  expect(() => formatDigest(base({
    fix: {
      pr: 'PR #4726',
      url: 'https://github.com/acme/repo/pull/4726',
      summary: 'Add the index',
      merged: false,
    },
  }))).toThrow(/fix\.summary/);
});

test('rejects empty projects, duplicate queries, and control characters', () => {
  expect(() => formatDigest(base({ mode: 'BACKTEST', backtestProject: '  ' }))).toThrow(/backtestProject/);
  expect(() => formatDigest(base({
    fix: { ...base().fix, merged: undefined },
  }))).toThrow(/fix\.merged/);
  expect(() => formatDigest(base({
    rows: [base().rows[0], { ...base().rows[0], total: 1 }],
  }))).toThrow(/rows\[1\]\.query/);
  expect(() => formatDigest(base({
    rows: [{ ...base().rows[0], query: 'bad`query' }],
  }))).toThrow(/rows\[0\]\.query/);
  expect(() => formatDigest(base({
    filed: [{ ...base().filed[0], id: 'PAT<8' }],
  }))).toThrow(/filed\[0\]\.id/);
  expect(() => formatDigest(base({
    filed: [{ ...base().filed[0], id: 'PAT>8' }],
  }))).toThrow(/filed\[0\]\.id/);
  expect(() => formatDigest(base({
    filed: [{ ...base().filed[0], id: 'PAT|8' }],
  }))).toThrow(/filed\[0\]\.id/);
  expect(() => formatDigest(base({
    filed: [{ ...base().filed[0], title: 'Bad|title' }],
  }))).toThrow(/filed\[0\]\.title/);
  expect(() => formatDigest(base({ ranking: 'handwritten' }))).toThrow(/ranking/);
});

test('keeps at least two decimals for sub-millisecond values', () => {
  const digest = formatDigest(base({
    rows: [{ query: 'near.one', execs: 1, mean: 0.9999, p95: 0.9999, total: 0.01 }],
  }));
  expect(digest).toContain('1.00 ms');
  expect(formatDigest(base({
    rows: [{ query: 'tiny', execs: 1, mean: 1e-30, p95: 1e-30, total: 0.01 }],
  }))).not.toMatch(/\b0(?:\.0+)? ms\b/);
});

test('rejects out-of-range durations and tolerates missing grouping fractions', () => {
  expect(() => formatDigest(base({
    rows: [{ ...base().rows[0], mean: 1e21 }],
  }))).toThrow(/rows\[0\]\.mean/);
  expect(formatDuration(1e21, 'ms')).not.toContain('undefined');
});

test('rejects negative durations', () => {
  expect(() => formatDigest(base({
    rows: [{ ...base().rows[0], p95: -5 }],
  }))).toThrow(/rows\[0\]\.p95/);
});
