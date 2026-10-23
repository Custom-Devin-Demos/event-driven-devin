# Best Buy — Black Friday checkout run sheet

Flow 1 (alert → Slack → Devin → PR) for a Best Buy audience. The talk track:
*It's Black Friday, the biggest shopping day of the year. Best Buy's newest
holiday perk (rewards for My Best Buy Plus and Total members) stops its most
loyal paying members from checking out. Devin picks up the alert, reproduces
it, finds the cause and comes back with a PR ready for review.*

- Page: `/best-buy` (alias `/4dd0a997`). Unlisted, not on the hub. The older Best Buy
  supply-chain demo at `/6074332d` is separate and unchanged.
- Endpoint: `POST /api/best-buy/checkout` (data: `GET /api/best-buy/storefront`)
- Service: `app/services/verticals/4dd0a997.js`
- Customer slug: `4dd0a997` (`DEVIN_SERVICE_KEY_4DD0A997`, `DEVIN_USER_ID_4DD0A997`,
  `DEVIN_ORG_ID_4DD0A997`, `BESTBUY_SLACK_MEMBER_ID`). Falls back to the shared GTM org;
  alerts and sessions are owned by Mark Porter by default.

## Why this scenario (public facts)

- Best Buy's 2026 holiday preview (corporate.bestbuy.com/2026/holiday-preview, Sept 14 2026):
  My Best Buy Plus and Total members earn 1% back in rewards on eligible purchases,
  or 6% back with a My Best Buy credit card. Black Friday 2026 is November 27.
- The paid membership used to be called **Totaltech**. Best Buy renamed it
  **My Best Buy Total** in June 2023.
- The product is the real bestbuy.com listing for the Samsung 65" S85H OLED (SKU 6671348,
  comp. value $1,999.99). The $1,099.99 Black Friday price is invented.

**Caveat:** the legacy `totaltech` program code below is invented for the demo. It is a
plausible migration seam. It is not a claim about how Best Buy stores memberships.

## The scenario

Jordan Reyes (`BBY-30418`) has been a paid member since March 2022, before the rename.
Their account still carries membership program `totaltech`. They add the TV to the cart
and click **Checkout** (paying with a My Best Buy Visa, which should earn 6% back):

`checkout()` → `priceOrder()` → `applyMemberRewards()` → `memberRewardRate()` looks up
`MEMBER_REWARD_RATES['totaltech']` (only `plus` and `total` exist) →
`TypeError: Cannot read properties of undefined (reading 'creditCard')`.

The "Demo shopper" picker (top right, under the header) shows the bug is targeted, not
"the site is down":

| Shopper | Result |
|---|---|
| Jordan Reyes, BBY-30418, Total member since 2022 (legacy `totaltech` code, pre-selected) | **Fails**: red "Sorry, something went wrong." banner with a reference ID; alert fires |
| Alex Chen, BBY-58120, Total member since 2024, My Best Buy Visa | Order placed, $66.00 rewards (6%) |
| Sam Patel, BBY-77302, Plus member, other Visa | Order placed, $11.00 rewards (1%) |
| Guest checkout | Order placed, no rewards |

## Run it

1. Open `https://devindemos.com/best-buy` (locally: `node app/server.js`,
   `http://localhost:3000/best-buy`).
2. Jordan is pre-selected ("Hi, Jordan · Total Member" in the header). Click **Add to cart**,
   then **Go to Cart**.
3. Optional: switch "Demo shopper" to Alex Chen and click **Checkout** (it succeeds), then
   go back, add the TV again and switch back to Jordan.
4. Click **Checkout**. The red banner shows "Sorry, something went wrong.", a reference ID
   and the TypeError.
5. Behind it: Sentry captures the exception (tags `route`, `membershipProgram`, `paymentType`),
   Datadog records `bestbuy_checkout.failure`, an alert card posts to Slack, and a Devin
   session is created with `REMEDIATION_DIRECTIVE` appended. The directive is scoped to this route only.
6. Switch to Slack and show the alert card and the Devin session link.
7. In the Devin session, Devin reproduces first at `/best-buy?repro=1`, which fails
   identically but raises no Sentry, Slack or Devin event.
8. Devin maps the legacy `totaltech` code to My Best Buy Total, makes unknown programs check
   out without rewards instead of crashing, records Jordan's order going through with $66.00
   in rewards, and opens a PR with both recordings.

## Safety notes

- `?repro=1` is ignored when `NODE_ENV=production`, so on devindemos.com every click on
  Jordan's **Checkout** raises a real alert and starts a Devin session. Test locally with
  alerts off (blank `SENTRY_DSN`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `DEVIN_API_KEY`).
- The bug is intentional. Keep it on `main` and close remediation PRs after the demo.
  To re-break after a merged fix, restore `memberRewardRate` to read
  `MEMBER_REWARD_RATES[membership.program]` with no legacy mapping or guard.
