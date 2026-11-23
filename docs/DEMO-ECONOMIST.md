# The Economist app — demo run sheet (`/economist`, slug `43e4e1fb`)

Synthetic replica of The Economist iOS app (Home with *The world in brief*, Top stories, vertical video, games; Weekly edition with cover, sections and audio; Video; Podcasts; Saved). Built from the public App Store screenshots, the 2025 app redesign press release and the Economist help centre. Internal demo only — not affiliated with The Economist Group.

| URL | Use |
|-----|-----|
| `/economist` (also `/the-economist`, `/economist-app`, `/43e4e1fb`) | Live demo: real Sentry + `#automated-alerts` + Devin session |
| `/economist?reports=off` | Rehearsal: same failure, no alert or session |
| `?reset=1` or <kbd>Alt</kbd>+<kbd>R</kbd> | Clear downloads, bookmarks and read history |

Before going live, pick your identity on the hub (`/`) so `devinUserId` / `devinOrgId` / `devinEmail` are in localStorage — the session lands in that org (Bobby: `org_69IXJFLrljx8zSAw`) and the alert @-mentions you.

## Act 1 — Event-driven incident response (≈3 min)

1. Open `/economist`. Tour Home: *The world in brief* carousel, Top stories, Watch, Play.
2. Tap **Weekly** → the Nov 21st edition *The machine-made economy* (includes a Technology Quarterly).
3. Tap **Download** → progress ring → **Download failed** sheet (`EDITION_DOWNLOAD_FAILED`, `TypeError … reading 'imageRendition'`).
   - Planted defect: `packageSection` looks up `SECTION_PACKAGING[sectionId]`, which has no entry for `technology-quarterly`. Keep it on `main`.
4. Show it is scoped: **All editions** → Nov 14th → **Download** succeeds (≈70 MB, audio included).
5. Switch to Slack `#automated-alerts`: alert card with the Sentry issue and the Devin session link. Open the session — Devin traces the culprit, adds packaging for the special section (and a safe default), adds a regression test and opens a PR.

## Act 2 — AI-led product development, Jira → tested PR (≈5 min)

Ticket: [BED-41 — Weekly edition: show reading & listening progress](https://cog-gtm.atlassian.net/browse/BED-41) (BN ENG Demo project). Read articles are already tracked in `econ:read`; the API already returns `wordCount` / `readMinutes` / `audioSeconds`, so the ticket is buildable in one session.

Start a Devin session (or assign the ticket to Devin) with:

> Implement Jira BED-41 in COG-GTM/event-driven-devin. Read the ticket's acceptance criteria, build it in the Economist app (`app/public/verticals/43e4e1fb.html`, `app/services/verticals/43e4e1fb.js`), add unit tests, run lint + tests, test it in the browser at `/economist?reports=off`, open a PR linked to BED-41 with before/after screenshots and a recording, and comment the PR link on the ticket. Do not fix the planted download failure.

Show: Devin reading the ticket → plan → code → tests → browser recording → PR → Jira comment.

## Files

`app/public/verticals/43e4e1fb.html`, `app/services/verticals/43e4e1fb.js`, `app/routes/verticals/43e4e1fb.js`, `config/customers/43e4e1fb.js`, `tests/43e4e1fb-edition-download.test.js`.
