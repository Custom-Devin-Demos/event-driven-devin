# Bumble demo (`/bumble`, customer `0f066b5c`)

Web replica of the Bumble iOS app (Bumble web was discontinued in 2026, so the
demo shows the mobile app in an iPhone frame) for a C-suite / CISO audience.
Two stories run on the same page:

1. **Incident → autonomous fix** (event-driven, live)
2. **AI-led product development lifecycle** (feature dev)

## 1. Incident: ID-verified members can't match

| Step | What to click | What happens |
|------|---------------|--------------|
| 1 | Open `/bumble` | People deck loads Maya, 29 — *ID verified* badge, Opening Move |
| 2 | **Like** (yellow check) | `POST /api/0f066b5c/swipes` returns 500, the "Something went wrong" sheet opens, the ops rail logs the 500 |
| 3 | — | `createSessionAndAlert` posts the alert to `#automated-alerts` and starts a Devin session in the presenter's org |
| 4 | **Keep swiping** → Pass → Like on Priya | Photo-verified profiles still match ("It's a match!" + Opening Move) |

Root cause (keep it — it is the demo): `VERIFICATION_TRUST` in
`app/services/verticals/0f066b5c.js` only knows `photo` and `selfie_video`.
Members verified with the newer government-ID flow (`government_id`) make
`scoreConnectionTrust` read `trustWeight` of `undefined`. Talking point for the
CISO: the most-verified, safest members are the ones locked out, and nobody had
to triage it — the alert, root cause and PR arrive in Slack.

Expected fix: add a `government_id` entry (highest weight) and fail safe for
unknown methods (treat as unverified instead of throwing), plus a regression test.

Local runs: `env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3100 node app/server.js`
keeps Sentry/Slack/Devin off. Set `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`,
`DEVIN_SERVICE_KEY`, `DEVIN_ORG_ID` to fire a real alert.

## 2. Feature dev: AI-led PDLC

The page is driven by `GET /api/0f066b5c/app` (viewer, people, matches), so
features land as a service + page change with tests, the same way as the fix.
Each scenario maps to a real 2025–26 Bumble launch. Paste one into a Devin
session (or a Jira/Linear ticket wired to Devin) and walk the lifecycle:
spec → plan → code + tests → PR with Devin Review → preview → merge.

**Share Date (safety, 2025 launch)** — recommended for the CISO
> In COG-GTM/event-driven-devin, add Bumble's "Share Date" feature to the
> `/bumble` demo (customer 0f066b5c). In a chat that has an `upcomingDate`
> (Jordan), add a "Share date" action to the date chip that opens a bottom
> sheet: pick a trusted contact, preview the venue, address and time, and
> confirm. Add `POST /api/0f066b5c/date-shares` that validates the match and
> contact, never returns the match's phone/email, and stores an expiring share
> (24h after the date). Show a "Shared with <name>" state on the chip. Add jest
> tests (validation, expiry, no PII leakage). Don't touch the planted
> `scoreConnectionTrust` bug.

**Review Before You Send (Trust & Safety)**
> Add a "Review before you send" nudge to the `/bumble` chat composer: before
> sending, call `POST /api/0f066b5c/message-review` which flags unkind or
> unsafe phrases from a small rules list and returns a suggestion; the UI shows
> a Bumble-style "Want to rephrase?" sheet with Edit / Send anyway. Unit-test
> the rules and the 400 path.

**Opening Moves picker**
> Let the viewer set their own Opening Move from the Profile tab: a sheet with
> Bumble's suggested prompts plus "Write your own" (max 120 chars, profanity
> check). Persist via `PUT /api/0f066b5c/viewer/opening-move` (in-memory) and
> render it on the profile. Add tests.

**Bee-powered Dates (AI matchmaker, 2026 pilot)**
> Add a "Dates by Bee" card to Discover: 3 short questions (what you want,
> values, deal-breakers), then `POST /api/0f066b5c/bee/introductions` scores
> the deck against the answers and returns one curated introduction with the
> reasons it was picked. Explainable scoring, no swiping, tests for scoring.

Narrative for the room: same agent, same repo, same guardrails (tests, Devin
Review, PR approval) for both the 2 a.m. incident and the roadmap feature.
