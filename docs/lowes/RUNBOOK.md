# Lowe’s shopping-cart / Teams rehearsal

## Scope and provenance

This is a **synthetic, guest-only web demo**, not a Lowe’s integration. No accounts,
payments, orders, live inventory, monitoring incidents, Slack messages, or new Devin
sessions are created by the default flow. No public deployment is authorized.

- Repository: https://github.com/COG-GTM/event-driven-devin (enterprise-internal).
- Customer: `a4c19e72`; routes `/lowes`, `/lowes-cart`, `/a4c19e72`.
- Existing references: Pepsi (`12b28f14`) catalog/checkout/page and Marshalls
  (`ea2d0dbc`) customer alias + bulky/category-specific fulfillment scenario.
- Registration: filesystem discovery, unchanged shared vertical registry and customer loader.
- Teams: existing `/api/oncall/trigger/:vertical` and `app/services/teams.js` card
  builder/transport. Lowe’s uses the standard selected-Teams sender and channel-owned responder.
  Local rehearsal previews the same card; live mode never falls back to Slack.
- Baseline: `devin/lowes-cart-b5f26e97`.
- Repair: `devin/lowes-pickup-fix-b5f26e97`, targeting the baseline, **not main**.
- [Preparation session](https://devin-gtm.devinenterprise.com/sessions/b5f26e97a86b49a59c23f5023ffc618e)
  is real but predates the alert. Do not call it an alert-created session.

## Five-minute web segment (leaves time for the separate iOS demo)

1. **0:00 — baseline.** Open `/lowes`. Point out the DEMO label, **Incident baseline**,
   Central Charlotte, refrigerator + DEWALT kit, local imagery, delivery and summary.
2. **0:30 — healthy control.** Continue to checkout with delivery. A synthetic quote
   succeeds; no order is placed. Reset cart, select **Pickup**, continue again.
3. **1:00 — failure and alert.** The cart is retained and a pickup error appears.
   Open **Teams / On-call preview**. Show the actual Adaptive Card JSON and the
   “Dry-run” / “nothing sent” disclosure. This is the existing on-call route, not a
   screenshot of a Teams post.
4. **1:45 — investigation evidence.** Show the preparation session and repair PR.
   Explain: the fulfillment-policy table has delivery/bulky and pickup/parcel,
   but lacks pickup/bulky. The same regression command fails before and passes
   after the repair. Investigation and PR were prepared ahead of this rehearsal.
5. **2:45 — replay fixed code.** Open the repaired local preview, confirm **Pickup
   policy repaired**, reset to delivery, switch the same cart to pickup and continue.
   It succeeds with a $0 pickup fee, preserved items, store, quantities and totals.
   This runs a separate code revision, not a UI success toggle or merged deployment.
6. **3:30 — healthy tools-only control and mobile.** Select Tools-only control,
   keep pickup, continue. Check the responsive cart, then reset. Leave the baseline
   ready for another rehearsal. Do not use unrelated hub/incident/telemetry buttons.

## Local replay and reset

Use the repo’s existing Express runtime. Start from a clean checkout with no `.env`
file (it must not load shared integration credentials). Dependencies: `npm install`.
Run each revision in its own worktree/terminal; the browser is the only stateful cart
and **Reset cart** restores the synthetic delivery cart. Refresh also resets it.

```sh
# Baseline checkout, terminal 1 — no inherited integration credentials:
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3100 \
  DD_TRACE_ENABLED=false node app/server.js

# Separate checkout of the repair branch, terminal 2:
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3101 \
  DD_TRACE_ENABLED=false node app/server.js
```

Open `/lowes` on the baseline and repair servers. `LOWES_DEMO_FIX_PR_URL` may be
passed explicitly to both commands after the repair PR exists; it adds an evidence
link only and cannot change checkout behavior. The Devin Computer tab is the private
interactive preview; do not publish the port or trigger deploy workflows.

```sh
npm run lint
npm test -- --runInBand
npx jest tests/a4c19e72-checkout.test.js tests/oncall-teams-alert.test.js tests/verticals-registry.test.js --runInBand
node scripts/a4c19e72-regression.js
docker build -t lowes-cart-demo .
```

The standalone regression is intentionally red on the baseline (`TypeError` reading
`fee`). It must pass **unchanged** on the repair at both stores with one and two bulky
items. Baseline Jest tests explicitly verify the planted incident, so ordinary test
success does not mean bulky pickup is fixed. There is no root `build` or TypeScript
script; the production artifact is the existing Dockerfile/Node application.

## Exact live prompt

> In Eashan Dev only, investigate the synthetic Lowe’s cart incident in COG-GTM/event-driven-devin on devin/lowes-cart-b5f26e97. Open /lowes locally with integrations disabled, confirm Central Charlotte and the refrigerator plus DEWALT kit, verify delivery succeeds, then switch to pickup and reproduce the failure; verify tools-only pickup still succeeds. Trace quoteCart’s fulfillment-policy lookup, add a focused regression test, and open a repair PR targeting devin/lowes-cart-b5f26e97, not main. Run the unchanged scripts/a4c19e72-regression.js before and after, run tests and lint, and record yourself replaying the same desktop and mobile browser flow against the fixed revision. Keep Teams dry-run, show the actual Adaptive Card payload, and distinguish this live investigation from prebuilt replay. Do not merge, deploy, create a repository, use Slack, post to shared on-call/customer channels, use real orders/payments/logins, or modify native iOS work.

## Standard Teams live path and safe rehearsal

The same `POST /api/oncall/trigger/a4c19e72` route supports both modes:

- **Default:** `LOWES_DEMO_LIVE_TEAMS` absent/false returns the exact standard
  Adaptive Card envelope with `dryRun:true,sent:false`. No send or session.
- **Approved live run:** set the single non-secret switch
  `LOWES_DEMO_LIVE_TEAMS=true` **only after destination and responder approval**.
  This follows `postOncallAlert → postTeamsAlert → postTeamsCard`, using the
  existing skin preference `ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI`, then the
  existing `ONCALL_TEAMS_WEBHOOK_URL` fallback. No new webhook scheme or custom
  send endpoint. Missing/invalid webhook fails closed; no Slack fallback even
  when the caller requests Slack.
- The Teams **channel responder** starts the investigation. The app does not
  create a duplicate session. `devinOrgId`/`devinUserId` in an app request do
  not configure ownership for Teams-created sessions.
- A successful send confirms transport acceptance only, not responder execution.
  Follow the originating Teams thread for the actual new session and repair PR.
- The native page owns its trigger, including under `/oncall/c/a4c19e72`;
  the shared on-call wrapper does not send a duplicate.
- Enable this only on an access-controlled demo runtime. The existing trigger is
  not a new authenticated production ingress. The normal upstream trigger cap applies.
- Never store or display webhook values in code, URLs, logs, browser state or PRs.

### Read-only readiness findings

- This VM has **no Teams webhook**. The existing live demo host reports
  `teamsDefaultWebhook:true` at https://devindemos.com/api/oncall/scenarios.
  This proves presence, not its destination or permission to send.
- Existing deployment sync maps `MAIN_ONCALL_TEAMS_WEBHOOK_URL` and
  `MAIN_ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI` Actions secrets to those runtime
  variables (see `.github/workflows/deploy.yml:79-108`,
  `scripts/deploy-ec2.sh:105-130`, `.env.example:96-109`).
  Reuse that configured Workflow once its exact destination is confirmed;
  absence in the VM is **not** a reason to create another webhook.
- COG-GTM / oncall-demo exists and is accessible. Historical Workflows cards are
  visible there. Access and historical traffic are not authorization for this run.
- The user's screenshot and a read-only thread lookup confirm the distinct
  **automations-demo** checkout path is working:
  `storefront → createSessionAndAlert → AUTOMATIONS_TEAMS_WEBHOOK_URL →
  Teams responder`. [Observed investigation session](https://devin-gtm.devinenterprise.com/sessions/25ecdc233e8a47bc987555a105c5c6c2).
  This does not prove Eashan Dev/Eashan ownership for an oncall-demo alert.
- Eashan Dev's currently listed responder is Slack-only and runs as a service user.
  A **disabled** Lowe’s-only Teams responder proposal was validated and submitted
  for approval separately. It watches top-level bot messages in oncall-demo with
  all three markers: `customer-a4c19e72-checkout`, `Synthetic demo alert`,
  `devin/lowes-cart-b5f26e97`; it runs as creator (Eashan).
- No existing responder was modified. No Teams message or responder test was sent.
  Do not enable until the channel owner/admin approves the target, confirms the
  Workflow mapping and prevents duplicate responders. Then separately approve one
  live trigger. A channel admin can confirm the mapping; Eashan is needed to approve
  the intended creator identity. An authorized presenter can launch afterward.

The responder's repo/branch restriction is a runbook instruction, not a hard GitHub
ACL. Its filter is schema-validated, but matching actual Adaptive Card text is
unverified until an approved real event is delivered. Network policy remains the
organization default; no telemetry or broad Slack grants were added.

## Publication safeguards

Inspected `.github/workflows/`: deployment only on main push/manual dispatch; sibling
sync only on main push/schedule/manual dispatch; unit tests on PRs into main;
Misfits E2E limited to its paths; stale-PR cleanup is scheduled/manual. Branch pushes
and these PRs do not invoke the deploy/sync workflows. No workflow was dispatched,
no default branch was written, and no merge is authorized. External hosting hooks
not represented in repository workflows cannot be attested from source alone.
