# Welcome-Season RxBIN Demo — Run Sheet

**Total run time: 5 minutes** (5:45 if you show the playbook — see 2:30 below). Two acts: the incident Devin fixes, then the sweep that would have prevented it.

Background for anyone technical who asks follow-ups: [`WIKI-PAYER-WELCOME-SEASON.md`](WIKI-PAYER-WELCOME-SEASON.md). You do not need it to present.

**The story in one line:** a health plan mailed 300,000 members ID cards with a 7-digit pharmacy BIN instead of 6. Every card looks perfect. Every prescription rejects at the counter starting January 1.

---

## Before you walk in (2 minutes, do this early)

1. Open the demo page: **`https://<demo-host>/welcome-season`**
2. Open a second tab on your Slack channel where Devin alerts land.
3. **Submit one claim now** (step 2 below) so the Devin session is already running while you talk. It takes a few minutes to produce a PR — you do not want to watch it live.
4. Have a terminal open, already in the repo directory.
5. Optional third tab: the playbook **Welcome-Season Pharmacy Routing Defect — Triage and Fan-Out** at https://app.devin.ai/settings/playbooks — open it now if you plan to show it at 2:30.

That's it. If you only do one thing: **trigger the claim before you start presenting.**

---

## The 5 minutes

### 0:00 – 1:00 · The member's card is wrong and nobody can tell

On `/welcome-season`, the member's digital ID card is on screen. Member is **Sandra Whitfield**, NC State Health Plan.

Point at the **RxBIN** field: `0044336`.

> "Pharmacy BINs are six digits. This one is seven. That card was mailed in November, it takes effect January 1, and there is nothing on it a member, a call center rep, or a pharmacist would flag as wrong."

The medication selector is on **Imatinib 400mg — chronic myeloid leukemia**. Leave it there.

Click **Submit Claim to Payer**.

> "This is the counter on January 2nd. She is picking up daily oral chemotherapy."

The claim comes back **REJECT 06**, and the member is asked for **$2,438.60 cash instead of a $50 copay** — with the clinical consequence spelled out underneath.

> "She is not going to pay twenty-four hundred dollars at the counter. She goes home without her chemotherapy, and this is the population where an interrupted course does not simply resume."

The other options in the selector are palbociclib, chemo anti-nausea, and insulin — pick any of them if someone asks whether this is cherry-picked.

### 1:00 – 1:45 · The signal is a business metric, not an alert

Scroll to the rejection-rate chart.

> "Two percent rejection rate through December 31st. Ninety-five percent from January 1st. Three hundred thousand members, roughly a hundred and twenty thousand rejected first fills in January — the peak month."

Then the line that matters:

> "Every service is healthy. No pod crashed, no latency spike, no error-rate alert. There is no infrastructure signal here at all — the defect is in plan configuration data. An observability correlation tool has nothing to correlate."

### 1:45 – 2:30 · The alert reaches Devin

Switch to Slack. The alert you triggered before you started is there, with Devin working.

> "The claim failure raised a real exception, Sentry caught it, and Devin picked it up from this channel."

### 2:30 – 4:00 · Four Devins in parallel

*Optional, ~30 seconds — skip if you are behind.* Switch to the playbook tab first:

> "This isn't Devin improvising. This is the runbook the team wrote once — rule out infrastructure, find the routing data, name the root cause, then fan these four workstreams out in parallel. Any engineer can trigger it by typing `!welcome_season_triage`, and it runs the same way every time."

Then open the Devin session. It has fanned the remediation out to four child sessions:

1. **Card-generation fix** — validate RxBIN/PCN/group against the processor registry before a card can be issued, plus a regression test → PR
2. **Blast-radius sweep** — audit *every* plan config, not just the one that alerted → PR wiring the check into CI
3. **Adjudication bridge** — route the bad BIN to the correct processor so members stop paying cash while cards reprint
4. **Member impact and comms** — affected-member list, pharmacy help-desk script, JIRA ticket

> "Four engineers' worth of work, running at the same time, on four machines. Not one ticket with a root cause in it — four branches and a fix."

Show the PR from workstream 1: the validation, and the test that makes this defect unshippable.

### 4:00 – 5:00 · The close: this never had to happen

In the terminal:

```bash
node scripts/welcome-season-sweep.js
```

It fails, loudly, in about a second. Read the bottom of the output out loud:

> "Two of four plans would produce cards that reject at the counter. Three hundred thousand members affected."

Then the point:

```
   Reactive:   Jan 2 alert → fast fix → ~$2M already spent
   Proactive:  December sweep → bad BIN never printed → $0
```

> "This check runs in October, before the print run. It found a *second* broken plan the alert never mentioned — NCSHP-8020 — because it audits the whole book, not the one plan that happened to page someone. Schedule it every welcome season and this incident does not exist."

Land it:

> "Two million dollars, a state-government contract at renewal, and a hundred and twenty thousand people who couldn't get their prescription — versus one validation check that a scheduled Devin run writes for you in December."

---

## Reset between runs

```bash
# nothing to reset in the app — it is stateless.
# just reload /welcome-season
```

To re-run the whole thing, submit another claim. Each claim raises a fresh alert and a fresh Devin session.

---

## If something breaks

| Problem | Do this |
| --- | --- |
| Page won't load | `docker compose up -d checkout-api` on the demo host, then reload |
| Claim returns "Network Error" | The API is down — same fix as above |
| No Slack alert appears | Slack/Devin env vars are missing on the host (`SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `DEVIN_API_KEY`). The member-facing acts (0:00–1:45) and the sweep (4:00) still work without them — skip to the sweep. |
| Devin session is slow | Use the pre-baked session and PR links you saved before the meeting. Never wait on screen. |
| Sweep prints PASS for everything | Someone already applied the fix. See "Two modes" below. |
| Someone asks a deep technical question | It is answered in `docs/WIKI-PAYER-WELCOME-SEASON.md` — offer to follow up rather than improvising. |

---

## Two modes — pick before you present

**Live-fix mode (default, how this ships):** the defect is in the code, so Devin actually fixes it during the demo. More impressive, depends on Devin finishing.

**Pre-fixed mode (deterministic):** if you want zero live dependency, change the two NC State Health Plan entries in `app/services/verticals/payer.js` from `rxBin: '0044336'` to `rxBin: '004336'` before the meeting. The claim then pays, the sweep passes, and you narrate the before/after instead of showing it. Change it back afterward.

---

## Numbers you may get asked about

| Question | Answer |
| --- | --- |
| How many members? | 300,000 across two plans (187,400 + 112,600) |
| Rejected first fills? | ~120,000 — about 40% of members fill an Rx in January |
| Hard cost? | ~$1.5–2M: ~$0.9M call center, ~$0.5M card reprint and remail, plus abandonment |
| Worse than the cost? | ~1,500–2,000 patients leak permanently to competitors (~$0.3M/yr recurring), and it's a state-government book at renewal with ~$7–8M/yr in admin fees behind it |
| Is this real? | Yes — a payer printed NC State Health Plan cards with an invalid RxBIN for the 2025 plan year. Names, member records, and claim data here are synthetic. |

---

## What's real vs. staged

- **Real:** the defect and the exception it throws, Sentry capture, the Slack alert, the Devin session and its PRs, the sweep and its exit code, the tests.
- **Staged:** member records, plan configurations, and the historical rejection-rate series on the chart (seeded, not queried from Datadog).
