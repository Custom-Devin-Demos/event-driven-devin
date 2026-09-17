# CommBank NetBank — "Pay anyone" run sheet

Flow 1 (alert → Slack → Devin → PR) for a CommBank Australia audience. The talk
track is: *a task handed to Devin from a ticket or Slack thread; nobody steers
each step, and the result comes back as a PR for your engineers to review.*

- Page: `/cba` (aliases `/commbank`, `/netbank`) — unlisted, not on the hub
- Endpoint: `POST /api/cba/payment`
- Service: `app/services/verticals/cba.js`
- Customer slug: `cba` (`DEVIN_SERVICE_KEY_CBA`, `DEVIN_USER_ID_CBA`, `CBA_SLACK_MEMBER_ID`)

## The scenario

Alice pays an invoice to a tradesperson from her Smart Access account using the
business's **ABN PayID**. The 2026 NetBank payee refresh added business (ABN)
PayIDs to the payee screens, but no NPP addressing profile was registered for
that PayID type, so NetBank has nothing to resolve the PayID against.

`settlePayment()` → `resolveAddressingProfile()` returns `undefined` →
`TypeError: Cannot read properties of undefined (reading 'directoryService')`.
The payment fails after the customer hits **Pay now**; the account is never
debited.

This is a configuration/rollout gap rather than a generic null dereference,
which is what makes it read as a real bank incident to a CBA audience.

## Run it

1. `node app/server.js`, open `http://localhost:3000/cba`.
2. The form is pre-filled: Smart Access `062-000 10345678` → Sunrise Plumbing
   Pty Ltd, ABN PayID `54 692 411 003`, $1,480.00.
3. Click **Pay now**. The red "We couldn't make this payment" panel shows the
   `TypeError` and a reference ID.
4. Behind it: Sentry captures the exception, Datadog records
   `cba_payment.failure` / `cba_payment.latency`, an alert card posts to Slack,
   and a Devin session is created from the alert with `REMEDIATION_DIRECTIVE`
   appended — scoped to this route only.
5. Devin registers the missing addressing profile, turns an unknown PayID type
   into a handled payments error, verifies in the browser and opens a PR.

Happy paths for contrast (no alert fires):

- PayID type **Email address** or **Mobile number** → Osko receipt in seconds.
- **Pay Anyone** tab (BSB `063-000`, account `41928375`) → Osko receipt.
- **BPAY** tab → BPAY receipt with the same-day cut-off window.
- Amount above the account's daily limit → handled 400, no incident.

```bash
# fails (ABN PayID)
curl -s -X POST localhost:3000/api/cba/payment -H 'Content-Type: application/json' -d '{}'

# succeeds (email PayID)
curl -s -X POST localhost:3000/api/cba/payment -H 'Content-Type: application/json' \
  -d '{"payIdType":"email","payId":"accounts@sunriseplumbing.com.au"}'
```

## Where to watch it

- The page: the red failure panel is the only on-screen signal.
- Slack: the alert card in the demo alerts channel. *On-Call* resolves to the
  `devinEmail` the page sent, else `CBA_SLACK_MEMBER_ID`, which defaults to
  Mark Porter.
- Devin: a new session appears within seconds, created as `DEVIN_USER_ID_CBA`
  (defaults to Mark) so it lands in his session list, and works to a PR.

Setting your org and email in the identity box on the hub (`/`) overrides both
for your browser, so the card mentions you and the session is created as you.

## Do not merge Devin's fix PR

The ABN PayID gap is the demo. Merging the fix PR that a demo run produces
disarms `/cba` for everyone on the next deploy — close those PRs instead, or
restore the defect by deleting the `abn` entry from `NPP_ADDRESSING_PROFILES`
and the `resolveAddressingProfile()` guard.

## Pre-fixing the demo

Add an `abn` entry to `NPP_ADDRESSING_PROFILES` in
`app/services/verticals/cba.js` and restart the server. Leave the defect in
place for a live run — the failure is the demo.

## Skin

`app/public/verticals/cba.html` uses CommBank's own palette and type: yellow
`#ffcc00`, ink `#231f20`, greys `#706d6e`/`#d3d2d2`/`#f4f4f4`, link blue
`#1175b5`, error red `#e1001a`, and the Beacon Sans faces plus the diamond logo
vendored under `app/public/verticals/assets/cba/`.
