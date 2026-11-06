# Amex Corporate KYC — presenter guide

> Fictional demo. The UI is a Devin demo copy, **not** the real American Express website. The policy pack in this folder is an illustrative stand-in, not Amex policy. No real Amex system is called.

## What the audience sees

Devin acts as a compliance-engineering teammate. It reads the internal KYC/KYB policies in this folder and EU Regulation 2024/1624 (AMLR), writes the requirements for a new EU market, draws a wireframe, and then ships a reviewable PR that adds that market to a live KYC portal.

## Before the demo

1. Run the app locally or use the shared demo host:
   ```bash
   npm install
   env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3100 DD_TRACE_ENABLED=false node app/server.js
   ```
2. Open both URLs in tabs:
   - Baseline (today): `http://localhost:3100/amex-kyc`, also at `/amex-corporate-kyc` and `/526efb4c`
   - Target market (not built yet): `http://localhost:3100/amex-kyc?market=FR`. This page should say **"KYC is not yet available for market FR"**.
3. Have the live-session prompt ready. The setup PR provides it.
4. Optional: open `docs/amex-kyc/wireframes/US-baseline.png` to show the wireframe convention.

## Demo credentials (fake)

| Login | Value | Card |
|-------|-------|------|
| Card details | Card number `378282246310005`, Card ID `4321` | Corporate Green Card |
| Card details | Card number `371449635398431`, Card ID `8765` | Corporate Platinum Card |
| My Account | User ID `jordan.ellis`, Password `Corporate2026!` | choose either card |

Fictional cardmember: Jordan Ellis, Harbor & Pine Coffee Roasters, Inc.

Valid sample answers: SSN `123-45-6789`, ITIN `912-70-1234`, US address `1420 Harbor Ave SW, Seattle, WA 98126`.

France (`/amex-kyc?market=FR`) sample answers: birth surname `Ellis`, surname of use `Martin`, born in `Lyon`, France · nationality France + second nationality United States · address `18 rue de la Paix`, Paris, `75002` · French passport `18AB12345` (any past issue date, future expiry, a `.pdf` upload) · numéro fiscal `1234567890123` (optional) · Manager, `Head of Purchasing`, employer SIREN `842 917 361` (fictional, passes the Luhn check) · PEP: None. Validation errors to show: `BP 45` as Address Line 1, post code `7500`, SIREN `842 917 360`, or the same country as first and second nationality.

## Run order

1. **Today's journey (2 min).** In `/amex-kyc`, show the USA PATRIOT Act notice. Log in with the card, then walk through Full Legal Name → Full Residential Address → National ID. Show one validation error, for example `P.O. Box 12` in Address Line 1. Sign the form (draw or choose) and submit to get a `KYC-XXXXXXXX` reference.
2. **The gap (30 s).** Open `/amex-kyc?market=FR` to show the market is not available yet.
3. **The inputs (1 min).** Show `docs/amex-kyc/README.md`, one policy, and `controls.json`. Explain that these are the internal rules Devin has to reconcile with the regulation.
4. **Kick off Devin.** Paste the live-session prompt. While it works, narrate its progress: it reads EUR-Lex and the policy pack, builds the requirements matrix, fills the country addendum, and draws the wireframe.
5. **Review the outputs.** Open the requirements matrix and the addendum. Point out the rows Devin marked as gaps or new obligations, and how each row traces to an AMLR article or national law and a `controls.json` ID.
6. **Wireframe → code.** Show the wireframe PNG in the PR description, then the diff. The market is added as data in `MARKETS`, with server-side validation and tests. The US journey is unchanged.
7. **Review loop.** Show the Devin Review findings on the PR and the follow-up commits that address them.
8. **Payoff.** Check out the PR branch, restart the app, and open `/amex-kyc?market=FR`. Walk through the new French journey. Then open `/amex-kyc` to show the US journey still works.

## Reset

All state is in memory. Restart the server to clear sessions and submissions. A second submit in the same session returns the original reference (HTTP 409).

## Where things live

- UI: `app/public/verticals/526efb4c.html` renders whatever `GET /api/526efb4c/form?market=<code>` returns.
- Questionnaire + validation: `app/services/verticals/526efb4c.js` (`MARKETS`, `validateStep`, `submit`).
- Routes: `app/routes/verticals/526efb4c.js`.
- Tests: `tests/526efb4c-kyc.test.js`.
- Wireframe convention: `docs/amex-kyc/wireframes/README.md`.
