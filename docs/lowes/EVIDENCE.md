# Public reference and scoped verification

## Observed public evidence

Captured with the org `reverse-engineer-anything` 6.4.0 skill using its documented
CLI fallback after the MCP launcher failed to find Node. Ordinary guest browser
navigation only; no anti-bot bypass, login, payment or order attempt.

| Public surface | Observation | REA evidence ID |
| --- | --- | --- |
| https://www.lowes.com/ | Navy navigation, store/pickup selector, catalog cards, cart entry | `ev_5c706f2c1011e5dcfe6a69ccda97aa1c8379bdf4008c0697dbbb31257b3d6ad1` |
| https://www.lowes.com/cart | Guest cart framing and empty-cart state | `ev_d412c8a6e95a2f9cc1389e9b45b1748f790c5d4ebd4c2af7bc00f48ef87d6970` |
| Cart viewport | Visible screenshot, no hidden state captured | `ev_e0ad0558692d859c87aa8455dbaf11ecff3cdaf7c7e3fdd1933d7e94b4576209` |
| [Klein Tools public product page](https://www.lowes.com/pd/Klein-Tools-Rechargeable-Slim-Profile-LED-Pocket-Flashlight-with-Laser/5016703487) | Pickup / Shipping / Fast Delivery options. Add to Cart returned “Something went wrong on our end. Please try again in a little while.” Stopped without bypass. | `ev_c3477855a2acba11d485c3d493219d67f50d987048bc0122338b733ca78d318c` |

Original screenshots and REA JSON are retained in the preparation session. REA
observations are passive and time-bound, not evidence of backend implementation.
No populated live cart or real checkout was verified. Central Charlotte, pricing,
inventory, tax, promises, regression and recovery in this demo are synthetic;
the public product page happened to select Rainier, not Central Charlotte.

Public image URLs cached locally for this internal, unlisted reference demo:

- Refrigerator: https://mobileimages.lowes.com/productimages/dc276c1b-d6f5-476a-8c5b-e41251ef1801/75981125.jpeg
- DEWALT kit: https://mobileimages.lowes.com/productimages/7d4223cc-1761-4269-aca8-d0972ba00555/102078092.jpeg
- Klein Tools light: https://mobileimages.lowes.com/productimages/382f209d-7618-4186-b68d-4fe7eb325203/72305233.jpeg

These are third-party brand/product assets, not newly licensed artwork. Do not
redistribute or publicly deploy this demo without the appropriate permissions.

## Change summary and usage map

- `config/customers/a4c19e72.js`: own customer/aliases, like Marshalls.
- `app/routes/verticals/a4c19e72.js`: catalog, synthetic checkout, standard checkout Teams integration.
- `app/services/verticals/a4c19e72.js:11-14,24-34`: fulfillment policy lookup,
  authoritative pricing and synthetic quote; bulky pickup is absent on the baseline.
- `app/public/verticals/a4c19e72.html`: cart UI → checkout → existing on-call trigger
  only on server error. No new session/Slack/telemetry calls in the vertical.
- `app/services/verticals/a4c19e72-alert.js`: existing Teams card builder/transport,
  scenario and responder notes. Standard Teams transport is reused in live mode.
- `app/services/devin-session.js`: new scenario, shared card construction, and Lowe’s-only rehearsal/no-Slack guards.
- `app/routes/oncall.js`: dry-run response label; legacy delivery text unchanged
  when `dryRun` is absent/false.
- Existing conventions: `12b28f14` and `ea2d0dbc` route/service/page/config files.

## CVE applicability and risk classification

No dependency bump, vendor advisory or CVE is part of this change. Inputs to checkout
and the send endpoint are untrusted HTTP input; product prices come from the server,
SKU/quantity/store/fulfillment are validated, and live transport requires explicit server-side opt-in after target approval. Primary operational risk is accidental
external notification; default dry-run and local credential-free startup isolate it.

No V&V test catalog, traceability matrix or severity/controllability matrix was supplied
for this synthetic demo. Formal risk scores, requirement/protocol IDs, and scoped vs.
full-catalog effort cannot be justified and are **unknown**, not fabricated. This
document is not a regulated validation assessment or an attestation of completeness.

## Scoped retest plan

| In scope | Existing executable evidence / rationale |
| --- | --- |
| Customer discovery, aliases, assets | `tests/a4c19e72-checkout.test.js`, `tests/verticals-registry.test.js` |
| Delivery, parcel pickup, invalid input, planted incident / repair | `tests/a4c19e72-checkout.test.js`; actual service policy lookup above |
| Identical fail-before/pass-after, stores, quantities and totals | `scripts/a4c19e72-regression.js` |
| Teams payload parity, no default send/fallback, live transport and responder ownership | Lowe’s tests plus `tests/oncall-teams-alert.test.js`; transport fully mocked |
| Shared on-call response compatibility | Existing on-call tests + recorded Lowe’s wrapper check |
| Desktop/mobile, dialog, reset, healthy control, recovery | Real browser rehearsal; recording is the evidence, not a source-only inference |

Out of scope: real Lowe’s orders/accounts/payments (no integration exists), native
iOS (no files touched), live Teams/responders (approval and host mapping outstanding), deployment
(no workflow changed or dispatched), unrelated fulfillment rules (no service changed).
The full Jest suite is also run as a broad compatibility check; unrelated known failures
are reported separately, not silently repaired or counted as Lowe’s verification.

## Residual risks

- Local test transport success does not prove live Teams rendering or session creation.
- Dry-run is a genuine payload preview; investigation/recovery are a prebuilt replay.
- Responsive browser checks do not imply native app testing or all-browser coverage.
- The missing bulky policy is intentional demo code and must not be treated as a
  production fix in the setup PR. Repair remains a separate, unmerged PR.
- Full public cart fidelity is constrained by the observed Add to Cart error.
- Third-party asset rights and externally configured hosting hooks remain human checks.
