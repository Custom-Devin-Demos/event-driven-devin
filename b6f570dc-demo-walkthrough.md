# PG&E — Outage Center address lookup demo (`/b6f570dc`)

## What I built

A clone of PG&E's public **Outage Center** (https://pgealerts.alerts.pge.com/) — the no-sign-in page where anyone types an address and gets outage status. It is unlisted: not on the hub, not in `/api/verticals`, reachable only at `/b6f570dc`.

Two views, both built from the live site's markup, computed styles, fonts and images:

1. **Home** (`/b6f570dc`) — "Get outage status", Search by Address / City-County, the address autocomplete, Report an outage / View outage map, the yellow 9-1-1 safety banner, the navy "Current situation" strip (99.9% with power · 60 current outages · 723 customers affected), the support teaser and cards, the wildfire-safety map tile, and the PG&E footer.
2. **Outage status** (`/b6f570dc/outage-status`) — breadcrumb, selected address, Current / Future / Map / Support tabs, "As of" timestamp, the result card, "Help during outages", and the "Help improve the Outage Center" feedback panel.

Behind it is `b6f570dc-api`: an address → premise → circuit → county lookup with realistic PG&E service points (Oakland, Foster City, Sunnyvale, Redwood City…), circuit snapshots, PSPS/outage state, and county roll-ups.

## The story

The address-status lookup is the thing PG&E built in eight days during the 2019 PSPS events, and it is the page the public hits first when the lights go out. In the demo, a recent change made the circuit-snapshot loader asynchronous (it now reads from a slower store). The status composer in a different module still treats the result as a resolved object. Every lookup that reaches the composer dies with:

```
TypeError: Cannot read properties of undefined (reading 'division')
```

Nothing fails on page load or on a timer — the error only happens when the presenter picks an address.

What happens on that click:

- The status page renders the loading skeleton, then the red "We can't show outage status for this address right now" card with the request reference, and a toast: `Outage status unavailable (HTTP 500) — TypeError: Cannot read properties of undefined (reading 'division')`.
- Winston logs the failure with request id, address, premise, circuit and stack trace. Datadog gets `b6f570dc.outage_status.failure` plus timing; Sentry gets the exception tagged `route=/api/b6f570dc/outage-status`, `service=b6f570dc-api`.
- A Slack alert lands in the on-call channel and a Devin session opens with the incident context. The stack trace points at the composer; the actual cause (the loader's changed return type) is in the other file — Devin has to follow it across modules.

The remediation is a small but real cross-file fix: make the composer await the snapshot (and propagate `async` through the lookup path), add a unit test for the composed view, and confirm the same address resolves to "Power is on" for Alameda County.

## How to present it

1. Open `/b6f570dc`. This is PG&E's public Outage Center — no login.
2. Click the address box and type **`300 Lakeside Dr`**.
3. Choose **`300 LAKESIDE DR OAKLAND CA 94612`** from the dropdown (the Lake Merritt office tower — PG&E's own building).
4. The page moves to **Outage status**, shows the skeleton for a moment, then the error card and the toast. Pause on the toast, then switch to Slack / Sentry / the Devin session.
5. A small grey **Reset** pill appears at the bottom-left after the failure. Click it to clear history and return to the clean home page; repeat steps 2–3 and it fails identically.

Anything else in the dropdown (Foster City, Sunnyvale, Redwood City) fails the same way; an address that is not in the service-point list returns a normal 404, not the bug.

## Where things live

- Page: `app/public/verticals/b6f570dc.html` (assets under `app/public/verticals/assets/b6f570dc/`, PG&E fonts self-hosted)
- Routes: `app/routes/verticals/b6f570dc.js` — `GET /b6f570dc/outage-status`, `GET /api/b6f570dc/addresses?q=`, `GET /api/b6f570dc/situation`, `POST /api/b6f570dc/outage-status`, `POST /api/b6f570dc/outage-status/reset`
- Service: `app/services/verticals/b6f570dc.js` (lookup, telemetry, Sentry, Devin session) and `app/services/verticals/b6f570dc-grid.js` (service points, circuits, snapshot loader)
