# Nourish mobile report bridge

`POST /api/nourish/mobile/error` accepts only this six-field fixture contract.
No messages, stacks, images, patient data, repo names or credentials are accepted.
Success is `202 {"accepted":true,"reportId":"...","duplicate":false}`.

Safe smoke test (always retain `x-synthetic`):

```sh
curl -i -X POST https://devindemos.com/api/nourish/mobile/error \
  -H 'Content-Type: application/json' -H 'x-synthetic: 1' \
  --data '{"schemaVersion":1,"errorCode":"NOURISH-MEAL-ANALYSIS-001","fixtureId":"avocado-toast-incomplete","screen":"meal-review","platform":"ios","appVersion":"1.0.0"}'
```

`platform` may also be `android` or `web`; all other values are exact. Invalid
JSON/schema returns 400, bodies over 2kb return 413, and excess attempts return
429. Per process, all attempts (including invalid, duplicate and suppressed)
count toward 10 per client IP and 100 globally per 10-minute fixed window.
Client buckets expire and are capped at 1000. Like the existing on-call limiter,
the bridge uses the rightmost X-Forwarded-For address appended by nginx, falling
back to the socket address without that header. Earlier caller-supplied entries
do not affect the bucket. Keep direct application access private behind nginx
so callers cannot forge the proxy-added address. The global limit still applies.

Identical reports dedup for 10 minutes, returning the original reportId with
`duplicate:true`. Suppressed and live reports use separate dedup state, with
at most six entries across three allowed platforms. Synthetic smoke tests and
disabled reports never swallow a subsequent live report on that platform. State is
in memory, resets on restart, and is not shared across replicas.

The presence of `x-synthetic`, `x-oncall-mode: 1`, `?reports=off`, or server
`NOURISH_REPORTS_DISABLED=1` suppresses **all** Sentry/Slack/Devin effects while
retaining the 202 contract. Run mobile reproductions with
`EXPO_PUBLIC_NOURISH_DISABLE_FAILURE_REPORTS=1`; never ship server secrets to Expo.

## Deployed-setup checklist (no deployment performed)

- Use the existing release/deploy pipeline for this Express application. No
  second service, mobile credentials, or new public deployment is required.
- Configure existing `SENTRY_DSN`, `SENTRY_ORG_SLUG`, `SENTRY_PROJECT_ID` and
  `SENTRY_CLIENT_SECRET`; keep the authenticated Sentry alert webhook pointed
  at `POST /webhooks/sentry`. Events carry `alert_path:instant` and a
  `nourish/mobile` culprit, both recognized by webhook dedup (including issue
  webhooks without event tags).
- Configure `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` (or
  `SLACK_CHANNEL_ID_NOURISH_MOBILE`), and optional triage channel per the normal
  alert setup. Confirm the bot can post there.
- Reuse `DEVIN_SERVICE_KEY` and `DEVIN_ORG_ID`, or supply
  `DEVIN_SERVICE_KEY_NOURISH_MOBILE` and `DEVIN_ORG_ID_NOURISH_MOBILE` to select
  another org. Existing `DEVIN_API_KEY[_NOURISH_MOBILE]` fallback is supported.
  Optional `DEVIN_USER_ID_NOURISH_MOBILE` selects an owner. The org must have
  repository access to `COG-GTM/nourish-mobile-demo` and a `macos` platform.
- The bridge fixes `repos` to that repository and requests
  `sessionPlatform:'macos'`. `devin-session.js` forwards it as `options.platform`
  to `devin-api.js`, which sends the v3 session body's `platform` field.
  The existing API retries on org-default placement if macos is rejected;
  the prompt instructs the responder to report a simulator blocker rather
  than delegate or claim verification. Validate org placement before live use.
- Start with `NOURISH_REPORTS_DISABLED=1`; perform the synthetic curl above.
  Remove the switch only for an intentional real incident. No live alert
  was sent as part of this implementation's tests.
- The responder prompt scopes remediation to React Native/Expo meal analysis,
  preserves baseline/planner, requires lint/typecheck/tests and before/after
  iPhone Simulator evidence, and requests a draft do-not-merge PR with no
  child-session parallelization. This bridge does not change the mobile app.
