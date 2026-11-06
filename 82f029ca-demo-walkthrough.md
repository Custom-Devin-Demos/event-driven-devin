# Boeing Global Services — AOG request on-call demo (`82f029ca`)

Self-hosted recreation of the public services.boeing.com **AOG & Emergency Support / Emergent Services** page
(https://services.boeing.com/maintenance/parts/aog). The page's lead form is extended into a
"Request AOG support" form for a grounded airplane. Not a real Boeing site.

- URL: `/boeing-aog` (also `/aog-request` and `/oncall/c/82f029ca`), unlisted
- Frontend: `app/public/verticals/82f029ca.html` (assets in `app/public/verticals/82f029ca/`)
- API: page calls `POST /api/82f029ca/aog-requests`; the on-call shim reroutes it to `POST /api/oncall/aogrequest/requests`
- Backend: `app/services/oncall-verticals/aogrequest.js`

## Demo flow

1. Open `/boeing-aog`. Click **Request AOG Support** in the page navigation to jump to the form.
2. The form is pre-filled: Abidjan Aero Technique, country **Côte d'Ivoire**, 737-800 tail **TU-TSZ** grounded at ABJ,
   part 65C27561-6, ATA 29 (hydraulic power).
3. Click **Submit**. It fails immediately with "We couldn't submit your AOG request. Please try again later." (HTTP 500).
   The grounded airplane never reaches an AOG desk. The shim posts the Slack alert
   ("5xx rate — Boeing AOG request: Submit") and a Devin session starts.
4. Healthy path: change Country to United States, Kenya or Singapore and submit again. The confirmation shows a request
   number (`AOG-YYMMDD-NNNN`), the regional AOG desk and the 30-minute first-response target.

## Planted defect (keep it)

`REGION_COUNTRIES` comes from the simulated `geo-ref@2026.11.04` country reference sync, which stored Côte d'Ivoire
under the mis-encoded name ``CÃ´te d`Ivoire`` (the same mojibake the live Boeing dropdown shows). The form submits
`Côte d'Ivoire`, so `routeToDesk` gets `undefined` from `COUNTRY_REGIONS`, `AOG_DESKS[undefined]` is `undefined`, and
reading `desk.name` throws `TypeError: Cannot read properties of undefined (reading 'name')`.

Expected fix: correct the country key (and normalise names before lookup) and fail safe to a default AOG desk instead of
throwing, so an AOG request is never dropped.

## Local testing without alerts

Run the server with an empty environment (`env -i PATH="$PATH" HOME="$HOME" PORT=3111 node app/server.js`) and abort
`/api/oncall/trigger/**` requests in the browser so no Slack or Devin alert is sent.
