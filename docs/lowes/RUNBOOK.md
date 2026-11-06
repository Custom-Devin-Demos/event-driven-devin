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

## Standard live Teams transport

Lowe’s captures the exception in Sentry and follows Pepsi’s standard card path:
`checkout failure → Sentry.captureException + createSessionAndAlert → persisted Teams destination →
AUTOMATIONS_TEAMS_WEBHOOK_URL → existing Teams responder`.

The card uses the standard Error, Severity, Location, Message, Release,
Environment and Triggered by fields, plus Watch Devin / Sentry / Datadog links.
No custom responder instructions are embedded. The frontend forwards the hub’s
saved org/user/email and uses existing locked host defaults on direct entry.
Sentry events carry `alert_path: instant` so the webhook fallback does not send
a duplicate alert. Local rehearsal does not capture Sentry events.

The hub stores the Slack/Teams selection in localStorage and the
`alert_destination` cookie. Its existing AsyncLocalStorage middleware carries
the cookie to the checkout service; no second browser trigger or custom send
endpoint exists. Choose **Teams** on the same host's hub, then open /lowes.

The official host already sets `NODE_ENV=production` (`Dockerfile:10`,
`docker-compose.yml:26`). With the existing valid Teams target and saved Teams
selection, failing checkout sends automatically — **no new host flag or secret**.
Local/development/test, CI, missing/invalid target, or explicit
`LOWES_DEMO_DRY_RUN=true` returns a no-send preview. A hosted Slack/unselected
preference never sends Slack: choose Teams on the hub. Other customers are unchanged.

Repeated live failures are limited to one send attempt per minute per process,
reserved before awaiting transport (including failed attempts). This is a bounded
demo safeguard, not distributed authentication/rate enforcement. Reset does not
clear the cooldown. Live mode inherits the existing authorized demo-host ingress.

Follow the originating Teams thread for the actual investigation link; transport
acceptance alone does not prove a responder session.

No custom oncall-demo skin/trigger, extra automation, responder signup or new
secret set is required to reuse the existing responder. That does **not** select
the responder's org or owner. For a separate personal automation, create it from
the intended human's account in Eashan Dev and select `run_as: creator`; verify
the saved creator is that human, not the service user that made an API call.
An additional Lowe’s-only automation on automations-demo can produce a second
investigation alongside the old automation. It must match only top-level bot
alerts containing `customer-a4c19e72-checkout` in that channel. Do not alter the
existing responder or shared Sentry configuration to resolve personal ownership.

The standard Watch Devin button links to an automation page, not the actual
investigation session. Use the new session link posted in the Teams thread.
The superseded oncall-demo responder proposal must remain unapproved.

### Observed vs unknown

- The user's screenshot and the existing automations-demo thread show a real
  Teams alert and [Devin investigation](https://devin-gtm.devinenterprise.com/sessions/25ecdc233e8a47bc987555a105c5c6c2).
  This proves the hosted checkout→Teams→responder path already works.
- Host /api/config reports teamsAlerts:true, confirming the standard checkout Teams target is configured (presence only, never its value).
- The VM has no Teams webhook. That is separate from existing host configuration.
  Host /health returns ok; /api/oncall/scenarios reports teamsDefaultWebhook:true,
  but that is the separate on-call variable, not proof of the automations target.
- `.github/workflows/deploy.yml` and `scripts/deploy-ec2.sh` already synchronize
  `MAIN_AUTOMATIONS_TEAMS_WEBHOOK_URL` to `AUTOMATIONS_TEAMS_WEBHOOK_URL`.
  No secret values were read or logged; no new route was provisioned.
- The existing responder owns session organization and run-as identity. App body
  IDs and card text do not override it. The linked session is not readable from
  this session's Eashan Dev scope (403), so exact org/owner remain **unverified**.
  Forwarding the hub identity is not proof of session ownership: the shared
  Teams branch returns `session: null` rather than calling the org/user-aware API.
  Do not claim that this card selects Eashan Dev or runs as Eashan.
- Branch restrictions belong to the explicit investigation prompt below; the
  standard notification card does not carry a custom repair playbook.
- Live posting, actual responder identity/branch compliance, and production
  rendering of this new vertical remain untested. No external message was sent.

## Exact live investigation prompt

> Investigate the synthetic Lowe’s pickup-checkout failure in COG-GTM/event-driven-devin, branch devin/lowes-cart-b5f26e97. Confirm you are in Eashan Dev as Eashan; report a mismatch instead of changing responders. Reproduce delivery passing and bulky pickup failing, keep parcel pickup healthy, fix the fulfillment policy and open a PR against that baseline branch only. Run scripts/a4c19e72-regression.js before and after, run tests/lint, and record desktop/mobile recovery. Use the existing Teams thread; no Slack, new automation, merge, deployment, real orders or iOS work.

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
