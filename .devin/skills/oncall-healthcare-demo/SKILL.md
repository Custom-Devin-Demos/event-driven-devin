---
name: oncall-healthcare-demo
description: >
  Build or customize a customer-branded healthcare On-Call demo (/oncall/c/<slug>)
  from one of the three healthcare templates on /oncall/healthcare — pbm (PBM /
  pharmacy claims), payer (health plan prior authorization) or lifesciences
  (pharma/biotech HCP sample ordering) — with Microsoft Teams alerts and
  Splunk/Dynatrace wording. Use whenever someone asks for a healthcare, PBM,
  payer, health plan, pharma or life-sciences on-call demo, or to reskin one of
  these templates for a customer. Delivers one PR (one skin entry + one page);
  never merges or deploys without approval.
---

# Healthcare On-Call demo (PBM / Payer / Life Sciences)

Deliverable: ONE PR into `COG-GTM/event-driven-devin` that adds a customer skin served at
`https://devindemos.com/oncall/c/<slug>`. The skin reskins one generic healthcare template; its
primary action is already degraded by the template's staged incident. Alerts go to Microsoft Teams
by default, and everything a viewer or responder reads (page, alert card, thread replies, Devin
prompt) is worded as a Splunk search plus a Dynatrace problem. Sentry and Datadog still collect the
telemetry underneath — never swap them for OTEL, Splunk HEC or a real Dynatrace integration.

The PR is a skin over shared mechanics: one `config/oncall-skins.js` entry plus one page in
`app/public/verticals/`, no backend changes. Merging to `main` triggers the EC2 deploy
(`.github/workflows/deploy.yml`), so merge and deploy each need the requester's explicit approval.

## Ask the user for

- **Customer name** (required); optionally a public URL and the product line to brand.
- **Template**: `pbm`, `payer` or `lifesciences` — propose one from the table below if not given.
- **Alert routing**: Teams (default) or Slack, and whether to force it for this skin.
- **Approval to merge and/or deploy** — never assumed.
- Bug-report or SEV-1 surfaces only if they explicitly ask (see "Optional surfaces").

## Templates (pick one, add none)

| Template | Page (`app/public/verticals/`) | Form | Legacy POST (keep in page) | Rerouted to | Payload fields (exact) | Symptom |
|---|---|---|---|---|---|---|
| `pbm` → `/oncall/pbm` | `pbm.html` | `#claimForm` | `/api/pbm/claim` | `/api/oncall/pbm/claim` | `memberId, ndc, pharmacyId, quantity, daysSupply, rxNumber, prescriberNpi` | Claim submit hangs ~8s, then 504 |
| `payer` → `/oncall/payer` | `priorauth.html` | `#priorAuthForm` | `/api/priorauth/submit` | `/api/oncall/payer/prior-auth` | `memberId, providerNpi, cptCode, icd10, serviceDate, urgency, clinicalNotes` | Each submit ~1s slower than the last (3s, 4s, 5s…); repeats within 60s join one incident |
| `lifesciences` → `/oncall/lifesciences` | `samples.html` | `#sampleOrderForm` | `/api/samples/order` | `/api/oncall/lifesciences/sample-order` | `hcpNpi, stateLicense, shipToAddressId, items:[{productId, quantity}], signature` | Sample order hangs ~10s, then confirms |

All three also send `devinUserId, devinOrgId, devinEmail` from localStorage and use `#submitBtn` and
`#result`. Fit: `pbm` for PBMs, pharmacy chains and retail pharmacy; `payer` for health plans,
utilization management and provider portals; `lifesciences` for pharma/biotech commercial and HCP
portals. Never use the legacy `/payer` page or the `insurance` vertical for these demos.

Each template page has its own visual identity; a customer reskin starts from a copy of the chosen
template page, not from another template or another customer's page.

## Procedure

1. **Repo and branch.** In `/home/ubuntu/repos/event-driven-devin`, confirm
   `git remote get-url origin` resolves to `COG-GTM/event-driven-devin` (never a fork).
   `git fetch origin main`, check that `ALERT_SCENARIOS` in `app/services/oncall.js` on `origin/main`
   has the chosen template with `group: 'healthcare'` (if not, stop and tell the user), then
   `git checkout -b devin/$(date +%s)-oncall-healthcare-skin origin/main`.
2. **Read** `AGENTS.md` ("On-call vertical slice" section), the header comment of
   `config/oncall-skins.js` (every skin option), the `<skin.teamsWebhookEnv>` / Teams notes at the top
   of `app/services/oncall.js`, the template's `ALERT_SCENARIOS` entry, the template page, and
   `.agents/skills/testing-oncall-skins/SKILL.md`.
3. **Research the brand.** If the customer has a kit in `~/healthcare-ui-skills`
   (`COG-GTM/healthcare-ui-skills`: Cigna, CVS, Aetna, UHC, Optum, Elevance, Humana, HCA, McKesson,
   Epic, NextGen, Kaiser, Tenet, Cardinal, Centene, Thermo Fisher, Boston Scientific, Amgen, Lilly),
   read its `README.md` and the customer's `.agents/skills/<customer>-ui/SKILL.md` and use its tokens,
   type, components and voice — but build in the template's static HTML, not React. Otherwise inspect
   the live public site in the browser: `getComputedStyle` fonts, sizes, radii and brand colors,
   header/footer structure, a full-page reference screenshot, and the customer's product vocabulary.
4. **Slug.** `openssl rand -hex 4`. The slug is the only identifier: never put the customer name in
   the config key, filename, branch, commit message, code comment or PR title.
5. **Page.** Copy the template page to `app/public/verticals/<slug>.html` and restyle it natively:
   - Brand colors go in the page's own `:root` (`--accent`, `--accent-soft`, `--ink`, `--muted`,
     `--surface`, `--paper`, `--rule`, `--chrome-bg`, `--chrome-text`, `--danger`, `--danger-soft`).
     Keep `--surface` light. A skin `theme` key is ignored when `page.file` is set.
   - Original letter or SVG mark (never a copied logo), nearest Google Font, imagery only hot-linked
     from the customer's own public CDN, checked for HTTP 200 and given an `onerror` fallback.
   - Keep every form id, `#submitBtn`, `#result`, the legacy POST path, the payload field names and
     every `<option value>` exactly as in the template — the backend only recognizes the template's
     fictional members, NDCs, CPT codes, NPIs, products and addresses. Only visible labels change.
   - Keep the `/api/config` bootstrap and the `/session-cap-banner.js` blocks.
   - Build result boxes with `createElement`/`textContent`, not `innerHTML` (Aikido flags it).
   - Keep the `<title>` identical to `page.title` in the skin (the shim does not rewrite it).
6. **Skin entry** in `config/oncall-skins.js` (quoted hex key):
   ```js
   '<slug>': {
     slug: '<slug>',
     company: '<Customer, as rendered>',
     brandMark: '<letter>',
     vertical: 'pbm',                      // or 'payer' | 'lifesciences'
     page: { file: '<slug>.html', title: '<flow> | <Customer>' },
     oncallOnly: true,                     // template has no legacy endpoint; /<slug> is served shimmed
     telemetryBrand: 'splunk-dynatrace',
     // alertDestination: 'teams',         // only if Teams must be forced regardless of the presenter's picker
     supportCenter: '<Customer> Support',
     disclaimer: 'NOT ACTUALLY A <CUSTOMER> SITE — internal demo only, not affiliated with, endorsed by, or a real <Customer> product.',
   },
   ```
   - Routing: the template's `defaultAlertDestination: 'teams'` already sends the page to Teams
     unless the presenter explicitly picked a destination on the hub. With no Teams webhook
     (`ONCALL_TEAMS_WEBHOOK_URL`, or the skin's `teamsWebhookEnv` env var) the server falls back to
     Slack. Set `teamsWebhookEnv` only if the user supplies a customer-specific webhook env var.
   - `alertCard` (optional): only to rename `service`, `team`, `release`, `title`, `endpointLabel`,
     `symptom`, `impact` in the customer's vocabulary. Keep `metricQuery` in SPL
     (`index=… | timechart …`), keep it metric-shaped, and leave the company name out.
   - Other header options (`hideRibbon`, `ribbonSide`, `paths`, `locale: 'es' | 'ja'`, `devinSession`)
     only when the user asks. Never add credentials or hard-coded `slackMemberId`/emails.
7. **Run.** `PORT=3100 node app/server.js` (add `ONCALL_TEAMS_WEBHOOK_URL` and the
   `SLACK_ONCALL_*` variables if provisioned). `fuser -k 3100/tcp` first if the port is busy. Restart
   after every edit to `config/` or `app/services/` — both are `require`-cached.
8. **Verify the new page** at desktop width and 390px against the checklist below, and capture
   desktop, 390px and post-submit screenshots.
9. **Verify the frontend still works (COG-GTM org rule).** With the server running, open the pages in
   the browser and navigate the main pages — `/oncall`, `/oncall/healthcare`, the template's
   `/oncall/<template>`, one other existing skin, and the new `/oncall/c/<slug>` — while recording
   the screen. The recording is the proof of no negative impact; attach it to the PR handover.
10. **Checks.** `npm run lint` (0 errors); the narrowest relevant Jest suites
    (`npx jest tests/oncall-hub-routes.test.js tests/oncall-skin-*.test.js` plus the template's
    `tests/oncall-pbm-claim.test.js`, `tests/oncall-payer-priorauth.test.js` or
    `tests/oncall-lifesciences-samples.test.js`); `git diff --check`; `aikido_full_scan` on both
    changed files with full file contents — fix and rescan until zero findings.
11. **PR.** Commit with a message containing "feature", push, run `fetch_pr_template`, review
    `git diff --merge-base origin/main`, and open the PR with the screenshots embedded. The last line
    of the PR body must be exactly `Devin-Org: engineering`. Fix CI until green and address Devin
    Review findings. Do not merge.
12. **Hand over** `https://devindemos.com/oncall/c/<slug>` with the recording. Say plainly it 404s
    until the PR is merged and deployed, and ask whether to do either. After an approved merge,
    confirm the deploy workflow succeeded and the URL returns 200 before calling it live.

## Verification checklist

- Disclaimer bar is the first body element; no "← All Demos" link.
- Submit shows the template's symptom in real wall-clock time, and the network log shows the
  template's rerouted `/api/oncall/...` path from the table.
- Alert card and Devin prompt say "Dynatrace problem" and "Splunk search", with no "Datadog" text
  and no "View in Datadog" button.
- `/oncall/c/<wrong-slug>` returns 404, and so do `/oncall/c/<slug>/report` and
  `/oncall/c/<slug>/incident`.
- `/oncall`, `/oncall/healthcare` and the template page are unchanged; the skin is linked from
  neither hub.
- Desktop and 390px: no horizontal overflow (`scrollWidth <= 390`), tap targets ≥ 44px, clean console.
- If no Teams or Slack destination is configured, report alert delivery as untested; never claim an
  alert posted.

## Optional surfaces (only when explicitly requested)

The default is alerts only. `main` has no per-skin bug-report portal (`/report`) or SEV-1 console
(`/incident`) route; building either needs new routes, so stop and agree scope with the user first.
The existing `datadogIncident: true` skin key declares a real Datadog incident per unique alert —
it is Datadog-branded, so confirm with the user before using it in a Splunk/Dynatrace demo.

## Copy

Plain and declarative, in the customer's own vocabulary. No emoji, no sales language, and never a
hint of the degradation's cause. Members, drugs and products keep fictional names unless the user
supplies real ones. No clinical claims.

## Never

- Merge or deploy without explicit approval.
- Add scenarios, services, endpoints, monitors, or shim/shared-CSS changes for a skin — if one seems
  needed, stop and ask.
- Implement OTEL, Splunk HEC or a real Dynatrace integration, or remove Sentry/Datadog instrumentation.
- Put the customer name in the slug, key, filename, branch, commit or PR title.
- Copy proprietary logos, images or font files into the repo.
- List or link skins from `/oncall` or `/oncall/healthcare`.
- Describe the degradation's cause anywhere (copy, config, PR, runbook).
- Claim a URL is live, CI is green or an alert posted without tool output showing it.
