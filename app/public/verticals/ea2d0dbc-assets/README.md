# Marshalls Best Gift Ideas demo assets

Source page: https://www.marshalls.com/us/store/shop/gifts-gifts-gift-shops-best-gift-ideas/_/N-700922201

The live page (including the shorter URL supplied by the requester) returned the Marshalls error page during capture. Layout, copy, product order, and CSS were recovered from the **2025-11-18 03:25:25 UTC** Internet Archive snapshot of that page. This is an archived-reference replica, not a verified match to the current live assortment.

- Product images: `https://img.marshalls.com/marshalls?set=DisplayName[f2],prd[<SKU>_<colorId>],ag[no]&call=url[file:tjxrPRD2_RB.chain]`, original URLs extracted from the archived DOM; first 24 products retained.
- Gift banners: `https://static.marshalls.com/us/content/HP_2025/OCT_WK1/<filename>`.
- Logo: `https://static.marshalls.com/content/m1/static_content/images/logos/Marshalls-Logo.svg`.
- Family-of-brand logos: `https://static.marshalls.com/content/m1/static_content/global_header/images/<filename>`.
- Fonts: `https://static.marshalls.com/us/store/resources/fonts/Marshalls-Sans-{Regular,Bold,Light,Medium}.woff2`.

Assets were retrieved successfully through Chrome and stored locally because command-line CDN requests returned 403. No live site JavaScript, trackers, cookies, or account data are included. Brand assets remain the property of their respective owners and are used for this requested demonstration.

The implementation uses the source's measured `#444d54` text, Marshalls Sans typography, 225px logo, 1280px content width, 1050×200 gift navigation, and four-column product grid. Product count is the actual 24-item demo subset rather than the archived 430-item assortment. Size/color filtering metadata and the checkout are demo fixtures. Checkout uses a sample address, no payment, and a fixed Massachusetts 6.25% demo tax rate; it is not Marshalls' checkout or tax policy.

## Demo path

Open `/marshalls` (alias of `/ea2d0dbc`). Quick Look on the first MAX STUDIO throw set → Add To Bag → Checkout → Place Order. The missing `gift-bundle` fulfillment rule triggers the deliberate error, Sentry capture, and the existing instant Slack/Devin incident path. The prompt targets `COG-GTM/event-driven-devin` and asks for a reviewable fix PR without merging/deploying. Instant-path webhook deduplication prevents a second session for the same capture.

Remove that item and order the DISNEY cookie jar to exercise the healthy path. `SHIP89` waives standard shipping at $89; oversized items retain their surcharge. Global deployment Sentry/Slack/Devin configuration applies unless overridden by the `EA2D0DBC` environment variables documented in `.env.example`.
