#!/usr/bin/env node
/**
 * FOX One plan page frontend-quality audit.
 *
 * Checks the shipped markup and CSS of `app/public/verticals/a75ccde9.html` for
 * the accessibility and Core Web Vitals regressions that a design-system review
 * would catch: text contrast, accessible names, keyboard-operable controls,
 * pointer target size, and images that shift layout or delay LCP. This is the
 * control that should have blocked the promo banner; it is not wired into CI,
 * which is why the banner reached production.
 *
 * Usage:
 *   npm run audit:fox            print findings, exit 1 when any are found
 *   npm run audit:fox -- --json  machine-readable findings
 *   npm run audit:fox -- --alert raise the Slack alert and open a Devin session
 */
const {
  PAGE_URL,
  auditPlanPage,
  reportQualityFindings,
} = require('../app/services/verticals/a75ccde9-quality');

async function main() {
  const args = process.argv.slice(2);
  const findings = auditPlanPage();

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ route: PAGE_URL, findings }, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write(`FOX One frontend quality audit (${PAGE_URL}): no violations\n`);
  } else {
    process.stdout.write(`FOX One frontend quality audit (${PAGE_URL}): ${findings.length} violation(s)\n`);
    for (const item of findings) {
      process.stdout.write(`  ${item.ruleId} [${item.impact}] ${item.selector}\n`);
      process.stdout.write(`    measured: ${item.measured}\n`);
      process.stdout.write(`    required: ${item.required}\n`);
      process.stdout.write(`    ${item.standard} — ${item.detail}\n`);
    }
  }

  if (findings.length === 0) return;

  if (args.includes('--alert')) {
    const { reference, sessionPromise } = reportQualityFindings(findings, {
      devinUserId: process.env.DEVIN_USER_ID,
      devinOrgId: process.env.DEVIN_ORG_ID,
      devinEmail: process.env.DEVIN_USER_EMAIL,
    });
    await sessionPromise;
    process.stdout.write(`Alert raised (reference ${reference})\n`);
  }

  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`FOX One frontend quality audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
