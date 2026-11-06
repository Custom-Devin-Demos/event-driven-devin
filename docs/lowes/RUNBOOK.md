# Lowe’s cart → Teams → Devin rehearsal

Synthetic WEB demo in COG-GTM/event-driven-devin. No real accounts, orders or payments.
Pepsi (12b28f14) and Marshalls (ea2d0dbc) are the reference verticals.
Customer slug: `a4c19e72`. Routes: `/lowes`, `/lowes-cart`, `/a4c19e72`.

The normal cart shows shopper-facing messages only. For presenter controls,
reset and Teams payload/status diagnostics, open `/lowes?ops=1`. This display-only
option does not enable, disable or otherwise change server-side alert delivery.

## Revisions and reset

- Baseline: `devin/lowes-cart-b5f26e97` — bulky pickup intentionally fails.
- Repair: `devin/lowes-pickup-fix-b5f26e97` — targets the baseline branch, not main.
- Reset cart restores Central Charlotte, refrigerator + DEWALT kit, delivery.
  Reset never deletes messages already sent. Reload resets all in-memory cart data.
- Parcel-only pickup is the healthy control. The flashlight search is usable on mobile.
- Never merge either PR or deploy without a separate instruction.

## Four-minute web demo

1. Open baseline /lowes?ops=1 for rehearsal controls (use /lowes for the shopper view). Show Central Charlotte and the refrigerator + DEWALT kit.
2. Delivery → Continue to checkout: success, demo confirmation only.
3. Switch to Pickup → Continue: real HTTP 500, cart retained.
4. Open Teams alert preview: actual standard checkout Adaptive Card JSON.
   In rehearsal nothing is sent and no alert-created session exists.
5. Explain root cause: `FULFILLMENT.pickup` lacks `bulky`; `quoteCart` dereferences
   its missing fee. Tools-only pickup still works.
6. Open the repair PR and repaired local preview. Repeat the same cart → pickup;
   HTTP 200, zero pickup fee, quantities and totals preserved.
7. Repeat on mobile, search Klein Tools, reset. Finish with the recorded evidence.

## Safe local startup

Use two worktrees (baseline and repair); do not switch a running server's checkout.
In each repository, install with `npm install` if needed, then:

```sh
env -i PATH="$PATH" HOME="$HOME" PORT=3011 NODE_ENV=test \
  DD_TRACE_ENABLED=false DD_LOGS_INJECTION=false LOWES_DEMO_DRY_RUN=true \
  node app/server.js
```

Use PORT=3012 in the repair worktree. Keep production .env files absent from these
worktrees. `LOWES_DEMO_FIX_PR_URL` may supply the repair link in the UI; it is not a
credential. The normal server uses dotenv, so an empty environment alone does
not override a local .env file.

## Standard live Teams transport, dedicated Lowe’s destination

Lowe’s captures the exception in Sentry and follows Pepsi’s standard card path:
`checkout failure → Sentry.captureException + createSessionAndAlert → persisted Teams destination →
LOWES_TEAMS_WEBHOOK_URL → eashan-demo → Lowe’s Checkout Automation`.

The card uses the standard Error, Severity, Location, Message, Release,
Environment and Triggered by fields, plus Watch Devin / Sentry / Datadog links.
No custom responder instructions are embedded. The frontend forwards the hub’s
saved org/user/email and uses existing locked host defaults on direct entry.
Sentry events carry `alert_path: instant`; tagless issue webhooks are also
suppressed by the Lowe’s culprit slug. The live Sentry link searches the captured
event ID; previews use a Lowe’s service/route filter because no event was captured.
Local rehearsal does not capture Sentry events.

The hub stores the Slack/Teams selection in localStorage and the
`alert_destination` cookie. Its existing AsyncLocalStorage middleware carries
the cookie to the checkout service; no second browser trigger or custom send
endpoint exists. Choose **Teams** on the same host's hub, then open /lowes.

The official host already sets `NODE_ENV=production` (`Dockerfile:10`,
`docker-compose.yml:26`). With the dedicated Lowe’s Teams target and saved Teams
selection, failing checkout sends automatically — no additional live-mode flag.
Local/development/test, CI, missing/invalid target, or explicit
`LOWES_DEMO_DRY_RUN=true` returns a no-send preview. A hosted Slack/unselected
preference never sends Slack: choose Teams on the hub. Other customers are unchanged.

Repeated live failures are limited to one send attempt per minute per process,
reserved before awaiting transport (including failed attempts). This is a bounded
demo safeguard, not distributed authentication/rate enforcement. Reset does not
clear the cooldown. Live mode inherits the existing authorized demo-host ingress.

Follow the originating Teams thread for the actual investigation link; transport
acceptance alone does not prove a responder session.

### Hosted setup

The dedicated channel is an intentional change from the original shared
automations-demo setup. Store its incoming Teams Workflow URL as the repository
Actions secret `LOWES_TEAMS_WEBHOOK_URL`. The normal deployment workflow and
host allowlist synchronize that one variable. A secret supplied only to a Devin
session does not configure the hosted app. Never put a webhook URL in source,
browser storage, a PR or a chat message.

Only customer `a4c19e72` opts into the dedicated target through `teamsWebhookEnv`.
Other customers retain `AUTOMATIONS_TEAMS_WEBHOOK_URL` and their existing routing.
Lowe’s never falls back to that shared target or Slack when its own target is
missing or invalid. Do not replace the shared secret to redirect one customer.

The dedicated [Lowe’s Checkout Automation](https://devin-gtm.devinenterprise.com/org/eashan-dev/automations/80bea729c76642c08bf5f12a610c9857)
must be enabled in Eashan Dev, created by Eashan Sinha and configured with
`run_as: creator`. Its trigger must match only `teams:message` events with:

- Team: `20ffc60a-db5d-48d3-aab2-200c66d8eba4`.
- Channel: `19:e15bb53a96314a4bab02f8c80d15359f@thread.tacv2` (`eashan-demo`).
- Sender type: `bot`; thread reply: `false`.
- Text containing `customer-a4c19e72-checkout`.

Do not alter existing responders or shared Sentry configuration. App body IDs
and card text do not override the automation’s session identity. Verify saved
creator/run-as metadata, then verify the actual resulting session separately.

The standard Watch Devin button links to an automation page, not the actual
investigation session. Use the new session link posted in the Teams thread.
The superseded oncall-demo responder proposal must remain unapproved.

### Live verification

Only after the target, enabled automation and runtime revision are verified,
exercise one explicitly authorized synthetic checkout through the actual cart.
Do not manually post a Teams message as a substitute. Confirm the alert in
eashan-demo, its automation event, the new session link in that thread, and the
session’s actual Eashan Dev organization and Eashan user metadata. Report each
unverified step separately; transport acceptance is not proof of a session.

For a VM integration check, keep Sentry/Slack/API credentials absent and label
it as local checkout → real Teams, not a hosted or live-Sentry verification.
Real Sentry capture should be exercised only after the duplicate-webhook fix
is deployed: an older hosted issue-webhook handler can lack the Lowe’s culprit
suppression. Unit tests mock Sentry and all transports; ordinary UI rehearsal
must remain local/test/dry-run and must never send externally.

## Exact live investigation prompt

> Investigate the synthetic Lowe’s pickup-checkout failure in COG-GTM/event-driven-devin, branch devin/lowes-cart-b5f26e97. Verify actual session metadata confirms Eashan Dev as Eashan; report a mismatch instead of changing responders. Check for an existing repair PR first. If the baseline branch no longer exists, stop and ask rather than choosing another branch. Reproduce delivery passing and bulky pickup failing, keep parcel pickup healthy, fix the fulfillment policy and open a PR against that baseline branch only. Run scripts/a4c19e72-regression.js before and after, run tests/lint, and record local desktop/mobile recovery. Use the originating eashan-demo Teams thread and post the actual new session URL, not the automation settings link. Sentry is read-only in devin-gtm. No hosted checkout, Slack, new automation, merge, deployment, real orders or iOS work.

## Checks

```sh
npx jest tests/a4c19e72-checkout.test.js tests/devin-session-teams.test.js tests/alert-destination.test.js tests/verticals-registry.test.js --runInBand
node scripts/a4c19e72-regression.js
npm run lint
npm test -- --runInBand
docker build -t lowes-cart-rehearsal .
```

The standalone regression deliberately fails on baseline and passes unchanged
on repair (both stores, quantities 1 and 2). Focused tests assert the planted
baseline failure as expected behavior. Full-suite unrelated failures must be
compared with untouched main and reported, never silently weakened.

## Publication safeguards

Non-default branches and PRs only. The existing production deployment is triggered
by pushes to main; no main write, merge, manual deployment or public preview was
performed. CI feature PR jobs do not authorize shared-channel sends.
