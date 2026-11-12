#!/usr/bin/env node
/**
 * Frontend latency test for the Fidelity Portfolio Summary (customer 0166f378).
 *
 * Drives the real page in Chromium the way a customer would, N times, and measures
 * the time from navigation until the positions grid is populated. Fails (exit 1)
 * when p95 exceeds the backend's published latency budget.
 *
 *   BASE_URL=http://localhost:3100 npm run e2e:fidelity-latency -- --runs 5 --screenshot /tmp/fidelity.png
 *
 * Flags:
 *   --runs N             page loads to sample (default 5)
 *   --screenshot PATH    save a screenshot of the final load
 *   --json PATH          write the samples + summary as JSON
 *   --live-alerts        do NOT append ?reports=off (every breach raises the real alert)
 */
const fs = require('fs');
const { chromium } = require('@playwright/test');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function main() {
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3100').replace(/\/$/, '');
  const runs = Number(flag('runs', 5));
  const liveAlerts = flag('live-alerts', false) === true;
  const pageUrl = `${baseUrl}/0166f378${liveAlerts ? '' : '?reports=off'}`;

  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const samples = [];
  let budgetMs = null;

  for (let run = 1; run <= runs; run += 1) {
    const startedAt = Date.now();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="positions-table"][data-loaded="true"]', { timeout: 60000 });
    const pageMs = Date.now() - startedAt;
    // eslint-disable-next-line no-undef
    const summary = await page.evaluate(() => window.__portfolioSummary || null);
    const backend = summary && summary.backend ? summary.backend : {};
    budgetMs = backend.budgetMs || budgetMs;
    samples.push({
      run, pageMs, backendMs: backend.durationMs || null, snowflakeMs: backend.snowflake ? backend.snowflake.durationMs : null, rowsReturned: backend.snowflake ? backend.snowflake.rowsReturned : null, queryId: backend.snowflake ? backend.snowflake.queryId : null,
    });
    process.stdout.write(`run ${run}: page ${pageMs}ms | backend ${samples[run - 1].backendMs}ms | snowflake ${samples[run - 1].snowflakeMs}ms | rows ${samples[run - 1].rowsReturned} | ${samples[run - 1].queryId}\n`);
  }

  const screenshot = flag('screenshot', null);
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: false });
  await browser.close();

  const pageTimes = samples.map((s) => s.pageMs);
  const backendTimes = samples.map((s) => s.backendMs).filter(Boolean);
  const result = {
    pageUrl,
    runs,
    budgetMs,
    page: { p50: percentile(pageTimes, 50), p95: percentile(pageTimes, 95), max: Math.max(...pageTimes) },
    backend: backendTimes.length ? { p50: percentile(backendTimes, 50), p95: percentile(backendTimes, 95), max: Math.max(...backendTimes) } : null,
    samples,
  };
  result.pass = budgetMs ? result.page.p95 <= budgetMs : true;

  const jsonPath = flag('json', null);
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  process.stdout.write('\n');
  process.stdout.write(`Portfolio Summary load (${runs} runs) — p50 ${result.page.p50}ms, p95 ${result.page.p95}ms, max ${result.page.max}ms; budget ${budgetMs}ms\n`);
  if (result.backend) process.stdout.write(`Backend /api/0166f378/portfolio-summary — p50 ${result.backend.p50}ms, p95 ${result.backend.p95}ms\n`);
  process.stdout.write(result.pass ? 'PASS: p95 within latency budget\n' : `FAIL: p95 ${result.page.p95}ms exceeds the ${budgetMs}ms latency budget\n`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(2);
});
