# FOX One web demo — run sheet

Two frontend flows on the same customer-branded page, `/oncall/c/a75ccde9` (skin `a75ccde9`, "Change Your Plan | FOX One"). Both end in a Devin session that records its browser work and opens a PR it does not merge.

Live: https://devindemos.com/oncall/c/a75ccde9
Local: `PORT=3100 SLACK_ONCALL_ALERTS_CHANNEL_ID=C0BNWUGCWBS node app/server.js`

## Flow 1 — client-side error → Sentry → Slack → Devin

What the audience sees: a viewer changing plans clicks **Annual**, pricing does not switch, a notice appears. No server error, no 500 — the failure is in the browser.

1. `renderPlanPricing('annual')` dereferences `PLAN_PRICING['PLUS-24'].annual`, which does not exist (the annual rollout shipped one plan short).
2. The click handler catches it, falls back to monthly, shows the notice, and POSTs the browser context to `POST /api/a75ccde9/error`.
3. `reportAppFailure` (`app/services/verticals/a75ccde9.js`) increments `plan_change.pricing_failure`, captures the exception in Sentry, and calls `createSessionAndAlert`.
4. Slack alert lands in the on-call alerts channel and a Devin session starts automatically with `APP_REMEDIATION_DIRECTIVE`.

The directive requires the session to `recording_start` **before** touching code, reproduce on the live page, fix locally, re-run the same click on localhost, `annotate_recording` both passes, `recording_stop`, and attach the recording plus both screenshots to the PR.

Run it on stage: open the page, click **Annual**, then switch to Slack.

## Flow 2 — nightly frontend-quality audit → Slack → Devin

What the audience sees: the promo banner marketing shipped on the plan page looks fine and fails an accessibility and Core Web Vitals review.

The banner (`.promo-banner` in `app/public/verticals/a75ccde9.html`) ships seven defects:

| Rule | Measured | Required |
|------|----------|----------|
| `color-contrast` | 3.07:1 (`#8C8C8C` on `#F7F4F0`) | 4.5:1 — WCAG 1.4.3 |
| `button-name` | dismiss control has no accessible name | discernible text or `aria-label` |
| `keyboard-operable` | `<div role="button">`, no key handler | native `<button>` |
| `interactive-role` | dismiss control is a `<span>` | `<button>` |
| `target-size` | 24x24px | 44x44px |
| `image-size-attributes` | no intrinsic `width`/`height` | reserved space, no CLS |
| `lcp-lazy-loaded` | `loading="lazy"` above the fold | `loading="eager"` + `fetchpriority="high"` |

Two ways to fire it:

```bash
npm run audit:fox                 # print findings, exit 1
npm run audit:fox -- --json       # machine-readable
npm run audit:fox -- --alert      # Slack alert + Devin session
curl -sX POST http://localhost:3100/api/a75ccde9/quality-audit   # same, from the app
```

`reportQualityFindings` raises `web_quality.violations`, a Sentry issue, and a Devin session carrying `AUDIT_REMEDIATION_DIRECTIVE`: record first, run axe-core and Lighthouse on the live page, fix every finding at the source, keep the plan-change flow intact, re-measure locally, and end the recording on a before/after scoreboard (accessibility score, CLS, LCP, axe violation count).

The audit is deliberately **not** wired into CI — that gap is why the banner reached production, and it is the prevention control the fix PR can add.

## Resetting between demos

Both defects are meant to stay in place. To run a flow pre-fixed, fix it on a scratch branch and `git checkout` the page afterwards:

- Flow 1: add an `annual` entry for `PLUS-24` in `PLAN_PRICING`.
- Flow 2: `npm run audit:fox` must exit 0.

Restart the server after either change.

## What to say it proves

- The event that starts Devin is a real user action in a browser, not a ticket.
- The evidence is a recording of the failure and the fix, not a claim.
- The same pipeline covers both firefighting (Flow 1) and quality debt (Flow 2).
- Nothing merges: every flow stops at a PR for human approval.
