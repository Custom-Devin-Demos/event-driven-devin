# DICK'S ScoreCard loyalty (mock) — DICK'S x Foot Locker integration demo

DICK'S acquired Foot Locker. This folder is the DICK'S side of the rewards
integration demo for the `1b17e823` vertical (devindemos.com/dicks).

> All members, earn rates and rules are invented for the demo. They are not the
> real ScoreCard or FLX programs.

| Folder | What it is |
|---|---|
| `scorecard/` | Mock ScoreCard loyalty API (system of record for DICK'S members). 200 seeded members in `scorecard/members.json`, in memory, reset on restart. |
| `rewards-bridge/` | **Empty.** Where the ScoreCard ↔ FLX integration goes. See `rewards-bridge/TICKET.md`. |

The Foot Locker side lives in its own repo, `COG-GTM/flx-loyalty`
(run it with `npm start`, default `http://localhost:4100`).

## ScoreCard API

Router: `app/routes/verticals/1b17e823-loyalty.js`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/1b17e823/scorecard/members/:id` | `id` is numeric, e.g. `8841207733` |
| GET | `/api/1b17e823/scorecard/members?email=&phone=` | **Exact** match on stored values (no case or phone normalization) |
| GET | `/api/1b17e823/scorecard/members/:id/transactions` | |
| POST | `/api/1b17e823/scorecard/members/:id/earn` | `{ amount, order_id }` → points; issues certificates |
| POST | `/api/1b17e823/scorecard/members/:id/redeem` | `{ points, order_id }`, single step, `409 insufficient_points` |

## ScoreCard rules (mock)

- Earn 1 point per $1, times the tier multiplier: `standard` 1x, `gold` 1.5x, `platinum` 2x.
- Every 300 points converts into a $10 reward certificate that expires 60 days after issue.
- Fields are snake_case; names are split (`first_name`/`last_name`); phone numbers are stored as typed (`(412) 555-0101`, `412-555-0142`, ...); emails are lowercase.

## Sample members

| ScoreCard ID | Name | Tier | Points | Notes |
|---|---|---|---|---|
| `8841207733` | Jordan Reyes | standard | 240 | Also an FLX member |
| `5520917046` | Casey Morgan | gold | 280 | Also an FLX member; one active $10 certificate |
| `6100457823` | Alex Kim | standard | 95 | DICK'S only |

The cart page (`app/public/verticals/1b17e823.html`) and checkout
(`app/services/verticals/1b17e823.js`) use their own built-in member list and
do not call this API yet.
