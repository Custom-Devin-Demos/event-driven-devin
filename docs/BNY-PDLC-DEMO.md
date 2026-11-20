# BNY demo 1: PDLC in Slack (Pershing Access price alerts)

Three personas (Rachel Kim, PM; Sofia Alvarez, designer; Tom Nguyen, Android lead) discuss price alerts on the Holdings screen of the Pershing Access Android app (`COG-GTM/android-demos` `apps/b113a373`) in `#bny-pershing-android-app` (C0CK3SP678E, formerly `#bny-pershing-access-android-app` and `#pershing-access-product`). Nobody @mentions Devin: when the discussion ends the iOS Engineer Bot (`bot-59656379ddc5470281166b1458334c2c`, Slack `U0CK6TNG7T3`) is paged through the v3 messages API, joins the thread on its own, files a Jira ticket (project `HB` on cog-gtm.atlassian.net, assigned to the engineering owner), scopes v1 with the ticket link, tags the app's engineering owner (Hannah Huh, `U0B2YAUPSHL`) and posts wireframes. The runner watches the thread: after the wireframes the designer asks for "the bell, but a % slider", after the revision the PM says go, and the Bot builds it and posts the PR (title starts with the Jira key), the Jira link, an owner tag and the preview.

## Trigger

- Page: `https://devindemos.com/bny-pdlc` (or `/9bfabd45/pdlc`), **Start discussion**.
- Presenter kickoff: **Wait for my Slack post** arms a run that posts no opener. The next top-level post from a person in the channel (within 30 min) becomes the thread in place of Rachel's opener; Sofia, Tom and Rachel reply in it and the Bot is paged as usual. API: `POST /api/9bfabd45/pdlc/run` with `{"kickoff":"person"}`.
- API: `POST /api/9bfabd45/pdlc/run`, `GET /api/9bfabd45/pdlc/state`, `POST /api/9bfabd45/pdlc/stop`. With `BNY_PDLC_TRIGGER_KEY` set, send it as `x-demo-key`.
- One run at a time, 2 min cooldown after a run ends. Each Bot stage times out after 30 min (90 min for the build).

## Requirements

- Persona app token (`BNY_PDLC_SLACK_BOT_TOKEN`, else `SLACK_ONCALL_BOT_TOKEN`) with `chat:write.customize` and `channels:history`, a member of the channel.
- The iOS Engineer Bot in the channel, and a way to wake it. A private Bot only takes v3 messages from its owner (403 for the service user), so set `BNY_IOS_BOT_WEBHOOK_SECRET` (Actions secret `MAIN_BNY_IOS_BOT_WEBHOOK_SECRET`, synced by `deploy.yml`, sent as `X-Webhook-Secret`; `BNY_IOS_BOT_WEBHOOK_URL` defaults to the iOS Engineer Bot's automation) to a `webhook:incoming` automation the Bot owns whose `message_session` action targets the Bot itself; `app/services/bot-pager.js` posts `{channel_id, thread_ts, event, bot_id, message, source}` there. Without it the page goes to the v3 messages API as `DEVIN_ONCALL_SERVICE_KEY`.

## Config

| Env | Default |
|-----|---------|
| `BNY_PDLC_CHANNEL_ID` / `BNY_PDLC_CHANNEL_NAME` | `C0CK3SP678E` (by ID, so a channel rename doesn't break runs); `BNY_PDLC_CHANNEL_NAME` looks a channel up by name instead |
| `BNY_PDLC_BOT_ID` | `bot-59656379ddc5470281166b1458334c2c` |
| `BNY_PDLC_BOT_SLACK_ID` / `BNY_PDLC_BOT_APP_BOT_ID` | `U0CK6TNG7T3` / `B0CK8N59ZLL` |
| `BNY_PDLC_JIRA_PROJECT` | `jira.projectKey` in the script (`HB`); the owner and Jira site/issue type are `engineeringOwner` and `jira` there |
| `BNY_PDLC_PERSONA_USER_TOKENS` | unset. JSON `{"<persona id>": "xoxp-…"}`: that persona's lines post as the real Slack member who owns the user token (user scope `chat:write`, member of the channel), under the member's own name and photo. The Bot watches the thread, so those lines reach it as Slack messages from a person and show that way in its Devin chat; the runner pages a line only if the Bot has not answered within 90 s (`userPostFallbacks` in the state). |
| `BNY_PDLC_ASSET_BASE_URL` | `https://devindemos.com` (host of the persona icon `/verticals/9bfabd45-person-outline.png`, which Slack must reach) |

Script: `config/nexen/pdlc-personas.json` (persona messages land 3-4 s apart; every persona uses the same person-outline icon). The page asks the Bot for phone-framed wireframes plus a self-contained HTML artifact, and for the build preview as an emulator video inside a phone frame plus an HTML summary. Service: `app/services/verticals/9bfabd45-pdlc.js`.

## Bot setup (one time, after a take, not during one)

Pages carry only the Slack lines (`#channel · Name: text`; the join page adds the thread link and the four discussion lines), so the Bot's chat reads like Slack. The Bot needs its standing instructions in its own memory first:
1. Ask the iOS Engineer Bot to save `docs/BNY-PDLC-BOT-INSTRUCTIONS.md` (rendered by `buildBotInstructions()`; a test keeps them in sync) as its standing instructions for `#bny-pershing-android-app`.
2. Ask it to change its `webhook:incoming` automation prompt to: "New Slack lines from a Pershing Access thread you follow; the payload names the channel and thread. Reply in that thread as a teammate, following your standing instructions for that channel and anything the lines ask." The KPI demo shares this automation, so keep the prompt neutral.

## Real Slack members for personas (scratch-channel check before a take)

Run this in a private scratch channel with iOS Engineer and the token's member in it, never in the product channel:
1. Top-level post with the user token and no @mention: does iOS Engineer's chat get a Slack message entry?
2. Page the Bot once for a thread (join page); it should `watch_thread`. Then reply in that thread with the user token: the reply should show in its chat as a Slack message from the member, and the Bot should answer it.
Only if (2) holds, set `BNY_PDLC_PERSONA_USER_TOKENS` for the take.
