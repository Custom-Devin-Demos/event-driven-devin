# Automations incident demo run sheet

This page describes the presenter-facing control plane. It does **not** run the
standing emitter. The standing Node service runs separately and is contacted
only through its HTTP admin contract.

## Before the call

1. Confirm the standing instance is healthy and reachable.
2. Set `AUTOMATIONS_DEMO_TOKEN` and open
   `/automations-demo?token=<AUTOMATIONS_DEMO_TOKEN>` once. The presenter page
   stores the token in session storage and sends it with every control-plane
   request. Mutation endpoints fail closed with `503 not_configured` when the
   token is not configured.
3. Click **Arm** about 45 minutes before the call. The standing service starts
   the `CUST_1` scheduled automation and returns `armed_at` and `next_fire_at`.
4. Leave the page open. Status should show an increasing error count and DLQ
   depth before declaring.

## Live sequence

Click **Declare** when Status says **Safe to declare** (at least 30–45 minutes
after arm, with errors flowing).

The control plane declares a SEV-1 incident through the Datadog Incidents
API. Datadog's Slack integration then creates the public incident channel
(named from the Datadog template, containing `incident-<publicId>-`). The
control plane polls `conversations.list` for that channel (up to ~10 minutes),
joins it, posts a factual SEV-1 declaration card, invites the Devin Slack
user, and drips 43 lines of ambient human conversation from T+30s through
T+40m of the declaration — modeled on the anonymized incident transcript:
early confusion, wrong theories (yesterday's matcher deploy, auth retries,
the second noisy tenant, AWS), the IC's evolving mental model, a
severity/blast-radius debate, an explicit fix delegation that @-mentions
Devin at T+8m, a mitigation-strategy argument (global flag vs targeted
disable), a "disabled the customer's automation" mitigation at T+24m, and
post-mitigation recovery/backfill/retro chatter through T+40m. The organization's prefix-based public-channel join hook
starts the incident session.

The card intentionally contains no root-cause claim:

- SEV-1 and the incident commander
- “Since ~`armed_at` all scheduled automations are failing”
- detection: reported by an employee; no monitor fired
- standing repository link and service tag

The run auto-stops after `AUTOMATIONS_DEMO_RUN_WINDOW_MS` (default 60 minutes).
Use **Stop** through the API if the call ends early:

```bash
curl -X POST "$DEMO_BASE/api/automations-demo/stop"
```

Cleanup cancels timers, posts a wrap message, disarms the standing instance,
closes open Devin-authored (`devin/*`) PRs in the standing repo, resolves the
Datadog incident, and marks the run stopped. Datadog's Slack integration owns
the channel lifecycle and archives it after resolution on its own schedule.
Slack/GitHub/Datadog failures are logged and do not strand cleanup.

**Manual step:** disabling the Devin-side incident automation is not
automatable today. After the demo, disable that automation manually in the
Devin control plane before the next customer run.

## Standing-instance admin contract

The standing repository must expose these authenticated endpoints. Every
request uses `Authorization: Bearer <AUTOMATIONS_DEMO_SERVICE_TOKEN>`, accepts
JSON where a body is specified, and returns JSON. The control plane uses short
HTTP timeouts and reports missing configuration or an unreachable instance
instead of pretending the operation succeeded.

### `POST /admin/demo/arm`

Request:

```json
{ "customer": "CUST_1" }
```

The service must enable the customer's scheduled automation and begin emitting
real failures. Response:

```json
{ "armed_at": "2026-01-01T12:00:00.000Z", "next_fire_at": "2026-01-01T12:05:00.000Z" }
```

`armed_at` is the authoritative ISO-8601 arm timestamp. `next_fire_at` is the
next scheduled automation execution.

### `POST /admin/demo/disarm`

Request body is empty. The service must disable the customer's failing
automation and purge its DLQ on the standing side; this app never holds AWS
credentials. Response:

```json
{ "disarmed_at": "2026-01-01T13:00:00.000Z", "dlq_purged": 42 }
```

### `GET /admin/demo/status`

Response:

```json
{
  "armed": true,
  "armed_at": "2026-01-01T12:00:00.000Z",
  "errors_since_arm": 17,
  "dlq_depth": 17,
  "emitter_heartbeat_age_s": 2
}
```

`errors_since_arm` and `dlq_depth` are numeric live counters. The heartbeat
age is seconds since the emitter last emitted telemetry. If the service is
unreachable, the presenter page must say **standing instance unreachable**.

## Environment

| Variable | Purpose |
| --- | --- |
| `AUTOMATIONS_DEMO_SERVICE_BASE_URL` | Base URL of the standing instance, without a trailing slash |
| `AUTOMATIONS_DEMO_SERVICE_TOKEN` | Bearer token for standing admin calls |
| `AUTOMATIONS_DEMO_TOKEN` | Required token for mutation endpoints; pass it to the presenter page with `?token=...` |
| `AUTOMATIONS_DEMO_TZ` | Presenter timezone for card timestamps; default `America/Los_Angeles` |
| `AUTOMATIONS_DEMO_RUN_WINDOW_MS` | Auto-stop duration; default 3600000 |
| `AUTOMATIONS_DEMO_IC_NAME` | Incident commander shown on the declaration card |
| `AUTOMATIONS_DEMO_STANDING_REPO_URL` | Repository link shown on the card; defaults to the standing repo |
| `AUTOMATIONS_DEMO_SERVICE_TAG` | Service tag shown on the card; default `automations-service` |
| `DD_API_KEY` / `DD_INCIDENT_APP_KEY` (or `DD_APPLICATION_KEY`) | Datadog keys used to declare/resolve the incident; declare fails closed without them |
| `DD_SITE` | Datadog site; default `us5.datadoghq.com` |
| `SLACK_ONCALL_BOT_TOKEN` (falls back to `SLACK_BOT_TOKEN`) | Slack token with `channels:read`, `channels:join`, `channels:write.invites`, history, message, and `chat:write.customize` scopes — no `channels:manage` needed |
| `SLACK_TEAM_ID` | Optional Slack team ID for presenter channel links |
| `DEVIN_SLACK_USER_ID` | Slack member ID invited into the public incident channel |
| `GITHUB_TOKEN` / `GH_TOKEN` | Optional GitHub token for closing `devin/*` PRs; cleanup logs a warning when absent |
| `SLACK_ONCALL_ALERTS_CHANNEL_ID` | Alert destination for a failed smoke run |
| `AUTOMATIONS_DEMO_BASE_URL` | Base URL used by the smoke CLI; defaults to local `PORT` |
| `AUTOMATIONS_DEMO_SMOKE_ACCUMULATION_WAIT_MS` | Smoke wait between arm and declare; default 1800000 (30 minutes) |

## API surface

All mutation endpoints require `AUTOMATIONS_DEMO_TOKEN`; status remains
unauthenticated so the presenter page can load before its token is entered.

- `GET /automations-demo` — presenter page (`X-Robots-Tag: noindex, nofollow`)
- `POST /api/automations-demo/arm`
- `POST /api/automations-demo/schedule` with `{ "declareAt": "<ISO>" }`; rejects targets under 30 minutes away, arms at T−45m for targets at least 45 minutes away, and arms immediately for 30–45 minute targets
- `POST /api/automations-demo/declare`
- `GET /api/automations-demo/status`
- `POST /api/automations-demo/stop`
- `POST /api/automations-demo/smoke`

## Monthly smoke

The smoke run arms, waits for `AUTOMATIONS_DEMO_SMOKE_ACCUMULATION_WAIT_MS`
(default 30 minutes) so the standing emitter has the same accumulation window
as a presenter run, declares a Datadog incident titled with a `[smoke]`
marker, waits for the Datadog-created channel, polls channel history for a
Devin root-cause post for up to 20 minutes, and always stops/cleans up. The CLI timeout is the configured wait
plus the 20-minute poll window plus a one-minute margin (51 minutes by
default). On failure it posts to `SLACK_ONCALL_ALERTS_CHANNEL_ID` and returns
failure.

Because `/api/automations-demo/smoke` can remain open for roughly 51 minutes
by default, the cron/CLI must call the app directly on its loopback port
rather than through nginx, whose standard proxy read timeout is 30 seconds.
The CLI defaults to that local app URL; set
`AUTOMATIONS_DEMO_BASE_URL` only when intentionally targeting another
directly reachable app instance.

Example cron line (run from the repository directory):

```cron
17 3 1 * * cd /home/ubuntu/repos/event-driven-devin && /usr/bin/node scripts/automations-demo-smoke.js >> /var/log/automations-demo-smoke.log 2>&1
```
