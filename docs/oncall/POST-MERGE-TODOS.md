# Devin On-Call Demo — Post-Merge TODOs

Outstanding items after this branch merges. Nothing here blocks the merge itself; the /oncall pages, support portal, and Slack posting are implemented and tested locally.

## 1. Prod deployment config

- [ ] Set `SLACK_ONCALL_ALERTS_CHANNEL_ID=C0BNWUGCWBS` (#oncall-alerts) in the deploy env.
- [ ] Set `SLACK_ONCALL_BUGS_CHANNEL_ID=C0BMWLRU4R1` (#oncall-bugs) in the deploy env.
- [ ] Optional: `SLACK_ONCALL_BOT_TOKEN` if the on-call channels should use a different bot than `SLACK_BOT_TOKEN`.
- [ ] Confirm `@automated_alerts` is a member of both channels (already invited as of Aug 2026).

## 2. Verify real telemetry end-to-end (once deployed)

The on-call pages now execute the real vertical code with an `x-oncall-mode` header, so Sentry `captureException` and Datadog metrics fire like the classic demos while only the legacy Slack/@Devin trigger is suppressed. This was NOT verified with live Sentry/Datadog keys — local test runs deliberately omitted them to avoid polluting the shared org (local events share the prod DSN, so Sentry alert rules + the prod `/webhooks/sentry` webhook could react to test errors).

- [ ] After deploy, fire one alert from each /oncall vertical and confirm the error appears in Sentry and Datadog.
- [ ] Known caveat: the Sentry-webhook fallback path (`/webhooks/sentry` → `createSessionAndAlert`) cannot see the `x-oncall-mode` header. If Sentry alert rules fire on on-call errors (they may not — planted errors are usually already-known grouped issues), a stray legacy alert could appear in the legacy channel. If that happens, either scope the Sentry alert rule or add a fingerprint tag for on-call events and filter in the webhook handler.

## 3. On-Call responders (Devin app config, not code)

- [ ] Alert Responder (#oncall-alerts): exists and validated (grouping + fresh investigation both confirmed live). Add runbook line: "Open the fix PR and stop; do not iterate on automated review-bot comments unless a human asks" (kills the 10-reply review threads). Enable Sentry + Datadog MCPs.
- [ ] Bug Responder (#oncall-bugs): create with the Bug Triage Responder runbook (delivered separately). Enable Sentry, Datadog, and Playwright MCPs. Metadata: `team:gtm-demo`, `type:bug-triage`, `channel:oncall-bugs`.
- [ ] After enabling the Bug Responder, fire a fresh test ticket from /oncall/report and verify it triages end-to-end (the earlier Dana Whitfield ticket predates the responder and may not be picked up retroactively).
- [ ] Responder PRs open against COG-GTM/event-driven-devin as demo artifacts — close them after demos, never merge (merging would deactivate the planted bugs).

## 4. Datadog SEV-1 incident flow (currently pinned)

Code is in place: the SEV-1 button declares a real Datadog incident via the Incidents API (us5) when `DD_API_KEY` and `DD_INCIDENT_APP_KEY` (falls back to `DD_APPLICATION_KEY`) are set, with fallback to a Slack SEV-1 post. Untested live. Remaining one-time setup (Datadog + Slack admin needed):

- [ ] Datadog → Integrations → Slack → connect the Cog GTM workspace (Slack app is installed; the Datadog-side link is not configured).
- [ ] Service Management → Incidents → Settings → Integrations → Slack → enable "Automatically create a Slack channel for each incident".
- [ ] Devin On-Call settings: enable the Incident Agent auto-join on `incident-*` channels.
- [ ] Deploy env: add `DD_INCIDENT_APP_KEY` and `DEVIN_SLACK_MEMBER_ID` (Devin app's Slack member ID — no default; without it the bot won't invite Devin to incident channels) to the host `.env`.
- [ ] Dry-run one incident from the /oncall button and verify: incident created → channel auto-created → Devin joins and investigates.
- [ ] Follow-up: SEV-1 registry and auto-resolve timers are in-process, so a restart/redeploy mid-window leaves the Datadog incident open (manual one-click resolve; channel still auto-archives). Consider a boot-time sweep that resolves open demo incidents whose summary contains the `run-` ref prefix.

## 5. Misc / cosmetic

- [ ] /oncall/report: the canned-template note link wraps onto two lines (cosmetic).
- [ ] Local dev note: Node 20.18 needs `node --experimental-require-module app/server.js` (uuid v13 is ESM); the prod Docker image is unaffected.
- [ ] Decide whether upstream demo PRs #3968/#3969 (responder artifacts) should be closed (#3968 already closed via Slack).
