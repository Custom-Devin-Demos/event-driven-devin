/* global afterAll, beforeAll, describe, expect, test */

const http = require('http');

const { compareBeforeAfter } = require('../scripts/patrol-before-after');

const servers = [];

function startServer(bodyFactory, statusCode = 200) {
  const server = http.createServer((req, res) => {
    const body = bodyFactory();
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function outputCapture() {
  let value = '';
  return {
    write(chunk) {
      value += chunk;
    },
    text() {
      return value;
    },
  };
}

async function runComparison(before, after, overrides = {}) {
  const output = outputCapture();
  const result = await compareBeforeAfter({
    before,
    after,
    path: '/internal-jobs/inventory-report',
    runs: 3,
    invariants: ['totalAvailable', 'innerQueryCount'],
    ...overrides,
  }, output);
  return { result, output: output.text() };
}

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

test('compares three runs and prints aligned rows with identical invariants', async () => {
  const before = await startServer(() => ({
    totalAvailable: 100,
    innerQueryCount: 10,
    totalDurationMs: 20,
  }));
  const after = await startServer(() => ({
    totalAvailable: 100,
    innerQueryCount: 10,
    totalDurationMs: 10,
  }));
  const { result, output } = await runComparison(before, after);
  expect(result.rows).toHaveLength(3);
  expect(output).toContain('pre-fix code');
  expect(output).toContain('fixed code');
  expect(output).toContain('speedup: 2.00x');
  expect(output).toContain('Invariants were identical across every run.');
});

test('rejects an invariant that differs between sides', async () => {
  const before = await startServer(() => ({ totalAvailable: 100, innerQueryCount: 10, totalDurationMs: 20 }));
  const after = await startServer(() => ({ totalAvailable: 101, innerQueryCount: 10, totalDurationMs: 10 }));
  await expect(runComparison(before, after)).rejects.toThrow(/totalAvailable/);
});

test('rejects an invariant that drifts on one side', async () => {
  let value = 100;
  const before = await startServer(() => ({ totalAvailable: value++, innerQueryCount: 10, totalDurationMs: 20 }));
  const after = await startServer(() => ({ totalAvailable: 100, innerQueryCount: 10, totalDurationMs: 10 }));
  await expect(runComparison(before, after)).rejects.toThrow(/totalAvailable.*drifted/);
});

test('rejects a missing invariant key', async () => {
  const before = await startServer(() => ({ innerQueryCount: 10, totalDurationMs: 20 }));
  const after = await startServer(() => ({ totalAvailable: 100, innerQueryCount: 10, totalDurationMs: 10 }));
  await expect(runComparison(before, after)).rejects.toThrow(/totalAvailable/);
});

test('rejects a non-2xx response', async () => {
  const before = await startServer(() => ({ totalAvailable: 100, innerQueryCount: 10 }), 500);
  const after = await startServer(() => ({ totalAvailable: 100, innerQueryCount: 10 }));
  await expect(runComparison(before, after)).rejects.toThrow(/HTTP 500/);
});

test('falls back to wall-clock timing when totalDurationMs is absent', async () => {
  const before = await startServer(() => ({ totalAvailable: 100, innerQueryCount: 10 }));
  const after = await startServer(() => ({ totalAvailable: 100, innerQueryCount: 10 }));
  const { output } = await runComparison(before, after, { runs: 1 });
  expect(output).toContain('Duration source: wall-clock around the request');
});

test('rejects a duration source that changes after the header is printed', async () => {
  let beforeCalls = 0;
  const before = await startServer(() => {
    beforeCalls += 1;
    return {
      totalAvailable: 100,
      innerQueryCount: 10,
      ...(beforeCalls === 1 ? { totalDurationMs: 20 } : {}),
    };
  });
  const after = await startServer(() => ({
    totalAvailable: 100,
    innerQueryCount: 10,
    totalDurationMs: 10,
  }));
  await expect(runComparison(before, after, { runs: 2 })).rejects.toThrow(
    /duration source changed on run 2: response totalDurationMs -> wall-clock around the request/,
  );
});

test('reports an uncomputable speedup when the fixed mean is zero', async () => {
  const before = await startServer(() => ({
    totalAvailable: 100,
    innerQueryCount: 10,
    totalDurationMs: 20,
  }));
  const after = await startServer(() => ({
    totalAvailable: 100,
    innerQueryCount: 10,
    totalDurationMs: 0,
  }));
  const { output } = await runComparison(before, after, { runs: 1 });
  expect(output).toContain('Mean pre-fix: 20.00 ms, mean fixed: 0.00 ms, speedup is not computable.');
  expect(output).not.toContain('Infinity');
});
