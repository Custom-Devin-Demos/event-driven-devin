# f687d492 — Official Close Publication console: UI test plan

Direct URL only: `http://localhost:3000/f687d492` (no hub card, not in `/api/verticals`).
Expected values below are derived from `app/services/verticals/f687d492.js`,
`f687d492-constituents.js` and `f687d492-dissemination.js`.

## 1. Branding & visual fidelity
- Header shows the S&P Global wordmark as an `<img>` (not text), a divider, then "S&P DOW JONES INDICES / Official Close Publication".
- Top bar reads "S&P Global · S&P Dow Jones Indices · Index Operations — internal, confidential" with a "← All Demos" link.
- Nav items: Overview, Index family, Distribution, Publication log. Red (#D6002A) 3px rule under the header; red primary button "Publish official close".
- Favicon loads from `/verticals/assets/f687d492/favicon.ico` (red square, white "S&P").
- **Pass:** logo image renders, no broken images, status strip shows green "STANDBY".

## 2. Dashboard / summary data (opening state)
- KPIs: Indices in scope = **5**; Constituents to price = **1,637**; Distribution channels = **4**; Recipients awaiting = **358**; Publications this week = **5 on time**, sub-line "Every session published before 16:20 ET".
- Status text: "Ready to publish the <today> official close for 5 indices."
- Pipeline hint: "Next publication PUB-<YYYYMMDD>-01"; all 5 stages numbered 1–5 (none green/red).
- Today's publication card: Tolerance band "±7% vs. prior close", Region "us-east-1 · DR us-west-2".
- **Pass:** every value above matches exactly; no "Reset" control visible anywhere.

## 3. Data tables
- Index family tab: 5 rows in order SPX / OEX / MID / SML / DJI with constituents 503 / 101 / 401 / 602 / 30 and prior closes 6,715.35 / 3,302.11 / 3,281.90 / 1,498.62 / 46,441.10; Official close column shows "Awaiting publication" chip on every row.
- Distribution tab: 4 rows — Exchange settlement values (4 recipients, 16:20 ET), Market data vendor feed (41, 16:30 ET), End-of-day index file (312, 17:15 ET), Public index pages (1, 17:30 ET); every status chip "Queued".
- Publication log tab: 5 rows, all "Published", recipients 358 and indices 5 on each row, durations 4.2s / 4.5s / 4.8s / 5.1s / 5.4s.
- **Pass:** row counts and values match exactly.

## 4. Bug trigger
- Click **Publish official close** once.
- **Pass:** bottom-right toast "PUBLICATION HALTED — TypeError: Cannot read properties of undefined (reading 'reduce')"; status strip flips to red "HALTED — Official close NOT published — stopped at Calculate official levels (SPX)…"; pipeline shows stage 1 green ✓ and stage 2 red "!"; a "Publication halted" card appears with Stage = Calculate official levels, Index = SPX, Error = TypeError, Publication = PUB-<YYYYMMDD>-01; Index family chips read "Not published"; Distribution chips read "Blocked"; Publications KPI sub-line "1 halted · deadline at risk"; small "Reset" control now visible left of the publish button.
- Server log contains "Official close publication halted" and "Posting alert and triggering Devin" exactly once per click; the response is HTTP 500 (not 404).

## 5. Hidden from hub
- Open `/` and `/api/verticals`.
- **Pass:** neither contains the string `f687d492`; no card refers to index publication.

## 6. Reset & repeat
- With the page halted, click the small **Reset** control.
- **Pass:** toast "RESET — Back to standby · console returned to its opening state"; status strip back to green STANDBY with the same text as a fresh load; KPIs return to the Section 2 values; Publication log shows exactly the 5 seeded "Published" rows (halted row gone); Reset control hidden again.
- Click **Publish official close** again → identical TypeError toast and halted state as Section 4.

## Non-firing check
- `rg -n "setInterval|setTimeout|visibilitychange|DOMContentLoaded|load'" app/public/verticals/f687d492.html` only matches the toast auto-dismiss `setTimeout`.
- Leaving the clean page open produces no `POST /api/f687d492/publish` in the server log until the button is clicked.
