# Field CTO Reservations — Slack app

Lets anyone in `#exec-field-requests` reserve a block of a Field CTO's time
without calendar access. Requests post as cards; admins (or the named Field
CTO) approve, decline, claim or reassign; approved slots get an `.ics` invite
in the thread. The authoritative answer to "who is reserved when" is
`/fcto schedule` and the App Home tab.

## Flow

1. `/fcto request` (or the **New request** button in App Home) opens a modal:
   account, purpose, who (a specific Field CTO or *any* — optionally US / EU /
   Japan hours), start, duration (30m … full day, or a custom end for
   multi-day blocks), meeting link, notes. Times are entered in the
   requester's Slack time zone and rendered in each viewer's time zone plus the
   Field CTO's local time.
   The modal also asks three required qualifications:
   * **Audience** — C-level / VP / Director / Below Director. *Below Director*
     can't be submitted (Field CTOs join Director-level and above).
   * **Country** — the 20 largest economies by GDP, plus Other.
   * **Industry** — Finance / Tech Native / Industrial / Healthcare /
     Public Sector / Other.
   Picking a country or industry pre-selects a suggested Field CTO (the
   requester can change it): Japan → Akira; Europe + Finance → Aman; Europe →
   Katrin; Finance elsewhere → Aman; other APAC → Akira; North/Latin America →
   any (US hours); Middle East → any (EU hours). The same rules rank and
   pre-select candidates in **Assign…** / **Claim**. Lists and rules live in
   `config/fcto-qualifications.js` (`ROUTING_RULES`, first match wins).
   Once a Field CTO (or "any …") and a time are picked, the form shows whether
   they are free then, or which approved reservation overlaps (pending
   requests don't count). Booked people can still be requested.
   Audience · country · industry show on the card, in `/fcto schedule`, and
   in the `.ics` description.
2. The card lands in the channel as **Pending**.
   * Specific person → **Approve** / **Decline** / **Reassign…** (admins) /
     **Cancel request** (requester or admin).
   * Any Field CTO → **Claim** (Field CTOs), **Assign…** (admins), Decline, Cancel.
   * Conflicts are shown on the card; approving over a conflict requires an
     explicit "Book anyway".
3. On approval the card flips to **Approved — @person is reserved**, a thread
   reply tags requester and Field CTO with the time in the Field CTO's zone,
   and an `.ics` file is attached for either side to add to their calendar.
4. `/fcto schedule`, `/fcto schedule next`, `/fcto schedule month`,
   `/fcto schedule @katrin`, `/fcto schedule me`, `/fcto roster`, `/fcto help`.
5. `/fcto free oct 22`, `/fcto free oct 22-24`, `/fcto free next week` — who has no
   approved reservation on those days (green / yellow = partly / red = 6h+ booked).
   Based on this app's reservations only; it can't see personal calendars.
   App Home shows counters (pending, booked, free today, waiting on you), a
   **Needs your action** queue with Approve / Claim / Assign buttons for admins
   and Field CTOs, a 7-day green/yellow/red heatmap per Field CTO with their
   photo and local time, the next three weeks of reservations, and your open
   requests.
6. Card design: the request details sit at the top (Field CTO photo,
   qualification chips like `:crown: C-level  :flag-jp: Japan  :bank: Finance`,
   purpose as a quote, local times). Status, a progress line
   (Requested → Field CTO → Approval → On the calendar) and the buttons sit in a
   color bar: yellow pending, green approved, red declined, grey cancelled.
   Approved cards and the approval thread reply get **Add to Google Calendar** /
   **Add to Outlook** buttons, which open a prefilled event in the clicker's own
   calendar. Photos come from `users.info` (existing `users:read` scope), are
   cached for 12 hours, and are skipped if Slack is slow.

## Who can do what

| Action | Admins (`FCTO_ADMIN_SLACK_IDS`) | Field CTO named on the request | Any Field CTO | Requester |
|---|---|---|---|---|
| Approve / Decline | yes | yes (own slot) | – | – |
| Claim an "any" request | – | – | yes | – |
| Assign / Reassign | yes | – | – | – |
| Cancel | yes | – | – | yes |

Everything is enforced server-side; unauthorized clicks get an ephemeral note.

## Setup (one time)

1. Create the app at <https://api.slack.com/apps> → **From a manifest** →
   paste `docs/slack/fcto-app-manifest.json`. Install it to the workspace.
2. Copy **Signing Secret** → `FCTO_SLACK_SIGNING_SECRET`, **Bot User OAuth
   Token** → `FCTO_SLACK_BOT_TOKEN` (falls back to `SLACK_BOT_TOKEN`).
3. `FCTO_CHANNEL_ID` = the channel ID of `#exec-field-requests` (the bot has
   `chat:write.public`, so it does not need to be invited; invite it anyway so
   people can @-mention it).
4. Admins: `FCTO_ADMIN_SLACK_IDS=U053N173C4E,U0AKUU81BR9,U…` (defaults to Jeff Wang and Nicole Zuuring; setting it replaces the default list).
5. Roster Slack IDs default to the known handles in `config/fcto-roster.js`;
   override any of them with `FCTO_SLACK_ID_<KEY>` in the environment. Members without an ID still show up and can
   be booked; they just can't be @-mentioned or act on their own requests.
6. Deploy. Slack will verify the events URL (`url_verification` is handled).

No SSH needed for the credentials: add Actions secrets `FCTO_SLACK_SIGNING_SECRET`
and `FCTO_SLACK_BOT_TOKEN` to this repo (Settings → Secrets and variables →
Actions). Every "Deploy to EC2" run writes them, plus `FCTO_CHANNEL_ID`
(`C0C96AUKY7R`, or the `FCTO_CHANNEL_ID` Actions variable), into the host
`.env` via the deploy env sync. Re-run the workflow after changing them.

Reservations persist in `data/fcto-reservations.json` on the Docker volume
(`FCTO_STORE_FILE` to override).

## Local testing without Slack

```
FCTO_ALLOW_UNSIGNED=1 FCTO_SLACK_API_BASE=http://localhost:4010 \
FCTO_CHANNEL_ID=C_TEST FCTO_STORE_FILE=/tmp/fcto.json npm start
```

`FCTO_ALLOW_UNSIGNED=1` skips signature checks (never set it in production);
`FCTO_SLACK_API_BASE` points the Web API client at a stub. Then post
`application/x-www-form-urlencoded` bodies to `/slack/fcto/commands`
(`command=/fcto&text=schedule&user_id=U1&channel_id=C_TEST&trigger_id=t`) and
`payload=<json>` to `/slack/fcto/interactions`. `GET /slack/fcto/health`
reports what is configured. Unit coverage: `tests/fcto-reservations.test.js`.
