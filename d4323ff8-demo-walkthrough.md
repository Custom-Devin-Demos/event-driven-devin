# myHalliburton — field ticket approval on-call demo (`d4323ff8`)

Recreated myHalliburton **Commerce Central → Field tickets** page, styled from the live halliburton.com site
(header, red search tile, Univers fonts, `#c00` red, network-pattern footer). The customer reviews a field ticket for a
completed job and approves it with an electronic signature. Not a real Halliburton site.

- URL: `/myhalliburton` (also `/halliburton-field-tickets` and `/oncall/c/d4323ff8`), unlisted
- Frontend: `app/public/verticals/d4323ff8.html` (CSS, logo, fonts and imagery in `app/public/verticals/d4323ff8/`)
- API: page calls `POST /api/d4323ff8/field-tickets/approve`; the on-call shim reroutes it to `POST /api/oncall/fieldticket/approve`
- Backend: `app/services/oncall-verticals/fieldticket.js`

## Demo flow

1. Open `/myhalliburton`. Karen Alvarez (Permian Ridge Operating) has four field tickets awaiting approval on the
   Ridgeback State pad, Delaware Basin.
2. **FT-4471093** is selected: ZEUS electric fracturing, stages 1–18, Ridgeback State 14-2H, $1,056,240. The approval
   form is pre-filled (PO-778214, AFE-26-0419) and the confirmation box is checked.
3. Click **Approve & e-sign**. It fails immediately with "We couldn't approve this field ticket. Please try again later."
   (HTTP 500). The ticket never posts to invoicing. The shim posts the Microsoft Teams alert card
   ("5xx rate — myHalliburton field ticket: Approve") and the Teams responder starts a Devin session.
4. Healthy path: pick **FT-4470881** (Cementing), **FT-4470612** (Wireline & Perforating) or **FT-4469954** (Baroid) and
   approve. The confirmation shows an approval number (`APR-YYMMDD-NNNNN`), the amount, PO and the 24-hour invoice note.

## Planted defect (keep it)

The simulated `ft-sync@2026.11.10` field ticket sync now stamps ZEUS electric frac tickets with the sub-PSL code `PE-EF`,
but `APPROVAL_ROUTING` in Commerce Central is keyed by parent PSL (`PE`). `routeApproval` gets `undefined` and reading
`routing.psl` throws `TypeError: Cannot read properties of undefined (reading 'psl')`.

Expected fix: resolve sub-PSL codes to their parent PSL (`PE-EF` → `PE`) before the lookup and fail with a clear,
logged error rather than a TypeError for a genuinely unknown PSL, with a regression test for FT-4471093.

## Local testing without alerts

Run the server with an empty environment (`env -i PATH="$PATH" HOME="$HOME" PORT=3111 node app/server.js`) and abort
`/api/oncall/trigger/**` requests in the browser so no Teams or Devin alert is sent.
