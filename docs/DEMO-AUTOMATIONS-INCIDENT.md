# Automations incident demo run sheet

This page describes the presenter-facing control plane. It does **not** run the
standing emitter. The standing Node service runs separately and is contacted
only through its HTTP admin contract.

## Before the call

1. Confirm the standing instance is healthy and reachable.
2. Open `/automations-demo`.
3. Click **Arm** about 45 minutes before the call. The standing service starts
   the `CUST_1` scheduled automation and returns `armed_at` and `next_fire_at`.
4. Leave the page open. Status should show an increasing error count and DLQ
   depth before declaring.

## Live sequence

Click **Declare** when Status says **Safe to declare** (at least 30–45 minutes
after arm, with errors flowing).

The control plane creates a public channel named
`sev-1-incident-<mmdd>-scheduled-automations-failing` (in
`AUTOMATIONS_DEMO_TZ`, default `America/Los_Angeles`). If the name exists, it
tries `-2`, `-3`, and so on. It posts a factual SEV-1 declaration card, then
drips ambient human conversation at T+30s, 1m, 2m, 3m, and 4m. It invites the
Devin Slack user; the organization's prefix-based public-channel join hook
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
closes open Devin-authored (`devin/*`) PRs in the standing repo, marks the run
stopped, and records the channel for the 24-hour archive sweep. The wrap
message says that the channel is archived after the run. Slack/GitHub failures
are logged and do not strand cleanup.

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
| `AUTOMATIONS_SERVICE_BASE_URL` | Base URL of the standing instance, without a trailing slash |
| `AUTOMATIONS_DEMO_SERVICE_TOKEN` | Bearer token for standing admin calls |
| `AUTOMATIONS_DEMO_TOKEN` | Optional token gate for mutation endpoints |
| `AUTOMATIONS_DEMO_TZ` | Presenter timezone for `<mmdd>` channel names; default `America/Los_Angeles` |
| `AUTOMATIONS_DEMO_RUN_WINDOW_MS` | Auto-stop duration; default 3600000 |
| `AUTOMATIONS_DEMO_IC_NAME` | Incident commander shown on the declaration card |
| `AUTOMATIONS_STANDING_REPO_URL` | Repository link shown on the card; defaults to the standing repo |
| `AUTOMATIONS_DEMO_SERVICE_TAG` | Service tag shown on the card; default `automations-service` |
| `SLACK_BOT_TOKEN` | Slack token with channel management, history, message, invite, and `chat:write.customize` scopes |
| `SLACK_TEAM_ID` | Optional Slack team ID for presenter channel links |
| `DEVIN_SLACK_USER_ID` | Slack member ID invited into the public incident channel |
| `GITHUB_TOKEN` / `GH_TOKEN` | Optional GitHub token for closing `devin/*` PRs; cleanup logs a warning when absent |
| `SLACK_ONCALL_ALERTS_CHANNEL_ID` | Alert destination for a failed smoke run |
| `AUTOMATIONS_DEMO_BASE_URL` | Base URL used by the smoke CLI; defaults to local `PORT` |

## API surface

- `GET /automations-demo` — presenter page (`X-Robots-Tag: noindex, nofollow`)
- `POST /api/automations-demo/arm`
- `POST /api/automations-demo/schedule` with `{ "declareAt": "<ISO>" }`; replaces the prior schedule and arms at T−45m
- `POST /api/automations-demo/declare`
- `GET /api/automations-demo/status`
- `POST /api/automations-demo/stop`
- `POST /api/automations-demo/smoke`
- `POST /api/automations-demo/archive-stale`

## Monthly smoke

The smoke run arms, declares into a required-prefix channel ending in
`-smoke`, polls channel history for a Devin root-cause post for up to 20
minutes, and always stops/cleans up. On failure it posts to
`SLACK_ONCALL_ALERTS_CHANNEL_ID` and returns failure.

Example cron line (run from the repository directory):

```cron
17 3 1 * * cd /home/ubuntu/repos/event-driven-devin && /usr/bin/node scripts/automations-demo-smoke.js >> /var/log/automations-demo-smoke.log 2>&1
```
