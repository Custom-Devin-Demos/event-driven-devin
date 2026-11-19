# BNY demo 1: PDLC in Slack (Pershing Access price alerts)

Three personas (Rachel Kim, PM; Sofia Alvarez, designer; Tom Nguyen, Android lead) discuss price alerts on the Holdings screen of the Pershing Access Android app (`COG-GTM/android-demos` `apps/b113a373`) in `#bny-pershing-access-android-app` (C0CK3SP678E, formerly `#pershing-access-product`). Nobody @mentions Devin: when the discussion ends the iOS Engineer Bot (`bot-59656379ddc5470281166b1458334c2c`, Slack `U0CK6TNG7T3`) is paged through the v3 messages API, joins the thread on its own, scopes v1 and posts wireframes. The runner watches the thread: after the wireframes the designer asks for "the bell, but a % slider", after the revision the PM says go, and the Bot builds it and posts the PR and preview.

## Trigger

- Page: `https://devindemos.com/bny-pdlc` (or `/9bfabd45/pdlc`), **Start discussion**.
- API: `POST /api/9bfabd45/pdlc/run`, `GET /api/9bfabd45/pdlc/state`, `POST /api/9bfabd45/pdlc/stop`. With `BNY_PDLC_TRIGGER_KEY` set, send it as `x-demo-key`.
- One run at a time, 2 min cooldown after a run ends. Each Bot stage times out after 30 min (90 min for the build).

## Requirements

- Persona app token (`BNY_PDLC_SLACK_BOT_TOKEN`, else `SLACK_ONCALL_BOT_TOKEN`) with `chat:write.customize` and `channels:history`, a member of the channel.
- The iOS Engineer Bot in the channel, and a way to wake it. A private Bot only takes v3 messages from its owner (403 for the service user), so set `BNY_IOS_BOT_WEBHOOK_SECRET` (Actions secret `MAIN_BNY_IOS_BOT_WEBHOOK_SECRET`, synced by `deploy.yml`, sent as `X-Webhook-Secret`; `BNY_IOS_BOT_WEBHOOK_URL` defaults to the iOS Engineer Bot's automation) to a `webhook:incoming` automation the Bot owns whose `message_session` action targets the Bot itself; `app/services/bot-pager.js` posts `{channel_id, thread_ts, event, bot_id, message, source}` there. Without it the page goes to the v3 messages API as `DEVIN_ONCALL_SERVICE_KEY`.

## Config

| Env | Default |
|-----|---------|
| `BNY_PDLC_CHANNEL_ID` / `BNY_PDLC_CHANNEL_NAME` | lookup of `bny-pershing-access-android-app` |
| `BNY_PDLC_BOT_ID` | `bot-59656379ddc5470281166b1458334c2c` |
| `BNY_PDLC_BOT_SLACK_ID` / `BNY_PDLC_BOT_APP_BOT_ID` | `U0CK6TNG7T3` / `B0CK8N59ZLL` |
| `BNY_PDLC_ASSET_BASE_URL` | `https://devindemos.com` (host of the persona icon `/verticals/9bfabd45-person-outline.png`, which Slack must reach) |

Script: `config/nexen/pdlc-personas.json` (persona messages land 3-4 s apart; every persona uses the same person-outline icon). The page asks the Bot for phone-framed wireframes plus a self-contained HTML artifact, and for the build preview as an emulator video inside a phone frame plus an HTML summary. Service: `app/services/verticals/9bfabd45-pdlc.js`.
