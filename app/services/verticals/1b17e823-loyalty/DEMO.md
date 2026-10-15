# Demo: DICK'S x Foot Locker rewards integration

Devin scopes, plans and builds the first slice of integrating Foot Locker's FLX
rewards with DICK'S ScoreCard, then records itself using the result.

## Pieces

| | Where |
|---|---|
| FLX loyalty service (Foot Locker) | `COG-GTM/footlocker`, `npm start` → `http://localhost:4100` |
| ScoreCard mock (DICK'S) | `app/services/verticals/1b17e823-loyalty/scorecard` |
| Integration target | `app/services/verticals/1b17e823-loyalty/rewards-bridge` (empty; `TICKET.md`) |
| Web UI | `http://localhost:3100/dicks` (cart page, ScoreCard Rewards panel) |
| Finished first slice (fallback) | branch `devin/1792041624-dsg-flx-bridge-fallback` |

## Prompt (one session)

```
We acquired Foot Locker. Scope the work to integrate Foot Locker's FLX rewards (COG-GTM/footlocker) with DICK'S ScoreCard in the devindemos.com/dicks vertical (COG-GTM/event-driven-devin, vertical 1b17e823). Write a brief plan including a field mapping between the two systems and open decisions, then stop for my approval. After approval, implement the first slice: an FLX member can link their FLX account on the DICK'S cart page and see their combined rewards balance. Run the web app and record a screen capture of the flow, then open a PR.
```

When it stops with the plan, reply `approved`.

## What to point out

- The two systems disagree on almost everything: numeric vs `FLX-` string IDs,
  snake_case vs camelCase, split vs full names, phone as typed vs E.164,
  1 pt/$ vs 10 pts/$, one-step redeem vs hold/capture.
- **Casey Morgan** (`SC-5520917046`, Gold) is in FLX as `FLX-Q7M4D` with a
  different email; only the normalized phone number links them.
- **Alex Kim** (`6100457823`) shares an email (different case) with FLX's
  *Alexis Kimball* (`FLX-R2C9T`): a different person. Good matching must not
  auto-link them.
- Jordan Reyes's existing "FLX X3 linked" badge belongs to the separate
  on-call demo (X3 crosswalks to a tier that doesn't exist and checkout
  fails). Don't fix it in this demo.

## Run locally (no real alerts)

```bash
# terminal 1
cd footlocker && npm install && npm start
# terminal 2 (event-driven-devin)
PORT=3100 SENTRY_DSN= DEVIN_API_KEY= SLACK_BOT_TOKEN= node app/server.js
```

Open `http://localhost:3100/dicks`, pick **Casey Morgan · ScoreCard Gold**,
click **Link your FLX account** → **Link**. Expected combined balance:
**405 pts** (280 ScoreCard + 1,250 FLX ÷ 10).

## Reset

Links and balances live in memory: restart both servers.

## Fallback

If the live build stalls, check out `devin/1792041624-dsg-flx-bridge-fallback`,
restart the DICK'S server, and walk the same flow.
