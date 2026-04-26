# Testing Event-Driven Devin Verticals

## Prerequisites
- Run `npm install` in repo root
- Start the server: `node app/server.js` (runs on port 3000)

## Hub Landing Page
- Visit `http://localhost:3000/` to see all 9 vertical demo cards plus any custom verticals
- Each card links to its vertical URL

## Testing Each Vertical

For each vertical, navigate to its URL, fill the form (defaults are pre-populated to trigger the bug), and click the submit button. Verify the error message appears in a red error box or toast notification.

### Standard Verticals

| Vertical | URL | Action | Expected Error |
|----------|-----|--------|----------------|
| Banking | `/banking` | Click "Transfer Funds" (Premium tier) | `Cannot read properties of undefined (reading 'toFixed')` |
| Financial Services | `/financial-services` | Click "Buy AAPL" | `Cannot read properties of undefined (reading 'rate')` |
| Insurance | `/insurance` | Click "Submit Claim" | `Cannot read properties of undefined (reading 'maxPayout')` |
| CPG | `/cpg` | Click "Place Order" | `Cannot read properties of undefined (reading 'find')` |
| High Tech | `/hightech` | Click "Provision License" | `Cannot read properties of undefined (reading 'pricePerSeat')` |
| Industrials | `/industrials` | Click "Create Work Order" | `Cannot read properties of undefined (reading 'laborRate')` |
| Healthcare | `/healthcare` | Click "Schedule Appointment" (December) | `Cannot read properties of null (reading 'copayAmount')` |
| Telco | `/telco` | Click "Upgrade Plan" (Family Plus) | `Cannot read properties of null (reading '1')` |
| Retail | `/retail` | Add item to cart, checkout, click "Place Order" | `Cannot read properties of undefined (reading 'name')` |

### Custom Customer Verticals

Custom verticals use hex-slug URLs instead of descriptive names. Errors display as a bottom-right toast notification that auto-dismisses after ~6 seconds.

| Customer | URL | CTA Button | Expected Error |
|----------|-----|------------|----------------|
| Marriott (beb4d43e) | `/beb4d43e` | "Book Now" | `Cannot read properties of undefined (reading 'available')` |
| SEB (4feeb7bb) | `/4feeb7bb` | "Aktuella bolåneräntor" | `Cannot read properties of undefined (reading 'riskPremium')` |
| JPMC (89c1f355) | `/89c1f355` | "Join our team →" | `Cannot read properties of undefined (reading 'totalHeadcount')` |

## API Testing (curl)

You can also test each vertical via curl. Each POST endpoint returns a 500 with error details:

```bash
# Banking
curl -s -X POST http://localhost:3000/api/banking/transfer -H 'Content-Type: application/json' -d '{"fromAccount":"ACCT-1001","toAccount":"ACCT-1002","amount":500,"accountTier":"premium"}'

# Financial Services
curl -s -X POST http://localhost:3000/api/trading/execute -H 'Content-Type: application/json' -d '{"symbol":"AAPL","side":"buy","quantity":10,"tierId":"1","accountId":"ACCT-INV-001"}'

# Insurance
curl -s -X POST http://localhost:3000/api/insurance/claim -H 'Content-Type: application/json' -d '{"policyId":"POL-5001","claimType":"collision","amount":5000}'

# CPG
curl -s -X POST http://localhost:3000/api/cpg/order -H 'Content-Type: application/json' -d '{"distributorId":"DIST-001","items":[{"sku":"BEV-001","quantity":50}],"warehouseRegion":"northeast","fulfillmentZone":"southeast"}'

# High Tech
curl -s -X POST http://localhost:3000/api/licenses/provision -H 'Content-Type: application/json' -d '{"planName":"enterprise ","seats":15,"orgName":"Test","billingCycle":"monthly"}'

# Industrials
curl -s -X POST http://localhost:3000/api/maintenance/workorder -H 'Content-Type: application/json' -d '{"equipmentId":"EQ-001","equipmentCategory":"Rotating","issueType":"preventive","priority":"high","estimatedHours":4,"partsEstimate":500}'

# Healthcare
curl -s -X POST http://localhost:3000/api/healthcare/appointment -H 'Content-Type: application/json' -d '{"patientId":"PAT-2001","providerId":"DR-101","department":"primary-care","year":2026,"month":12,"day":15}'

# Telco
curl -s -X POST http://localhost:3000/api/telco/upgrade -H 'Content-Type: application/json' -d '{"accountId":"CUST-3001","currentPlanCode":"BASIC-12","targetPlanCode":"FAMILY-PLUS-12"}'

# Retail
curl -s -X POST http://localhost:3000/api/storefront/checkout -H 'Content-Type: application/json' -d '{"items":[{"sku":"WDG-001","quantity":1}],"region":"US","persona":"buyer_1"}'

# Custom Verticals — Marriott (beb4d43e)
curl -s -X POST http://localhost:3000/api/beb4d43e/inquiry -H 'Content-Type: application/json' -d '{"property":"maui","roomType":"suite","priority":"standard"}'

# Custom Verticals — SEB (4feeb7bb)
curl -s -X POST http://localhost:3000/api/4feeb7bb/inquiry -H 'Content-Type: application/json' -d '{"loanType":"mortgage","region":"stockholm","rateType":"variable"}'

# Custom Verticals — JPMC (89c1f355)
curl -s -X POST http://localhost:3000/api/89c1f355/inquiry -H 'Content-Type: application/json' -d '{"division":"investment-banking","region":"north-america","assetClass":"equities"}'
```

## Pre-PR Verification Checklist (MANDATORY)

Before submitting any PR that adds or modifies verticals, you MUST complete ALL of the following:

### 1. Visual Verification
- [ ] Start the local server (`node app/server.js`)
- [ ] Open each modified vertical page in the browser
- [ ] Verify ALL images load (no broken image icons, no 404s)
- [ ] Verify hero/key images are properly framed (not cropped to show just hair, sky, etc.)
- [ ] Compare the clone side-by-side with the live public site to confirm pixel-perfect accuracy
- [ ] Check that hotlinked images from external CDNs return HTTP 200 (many CDNs block hotlinking with 403)

### 2. Image URL Verification
- [ ] Run `curl -s -o /dev/null -w "%{http_code}"` against every image URL in the HTML file
- [ ] Any URL returning non-200 must be replaced with a working alternative (prefer Unsplash)
- [ ] Visually verify replacement images in the browser — confirm they show the correct city/subject (not a random city)

### 3. Functional Verification
- [ ] Click the CTA button on each vertical
- [ ] Verify the error toast appears at bottom-right with the correct TypeError message
- [ ] Verify the toast auto-dismisses after ~6 seconds
- [ ] Check server logs for `createSessionAndAlert` being called (look for "Posting alert and triggering Devin" log line)

### 4. Devin Session Triggering
- [ ] Verify the service file's catch block calls `createSessionAndAlert()` with correct parameters
- [ ] Verify `customer: '<slug>'` is passed in the alertData
- [ ] Verify the frontend sends `devinUserId` and `devinOrgId` in the POST body
- [ ] Verify the customer slug exists in `config/customers.js`
- [ ] Verify per-customer env vars are listed in `docker-compose.yml` and `.env.example`

### 5. Screenshots
- [ ] Take a screenshot of each vertical page showing correct rendering
- [ ] Include screenshots in the PR description as evidence

## Notes
- All bugs are intentional — they are designed to trigger the Sentry/Slack/Devin investigation pipeline
- Each bug has a root cause in a different function from where the crash occurs
- The frontends pre-populate form values that trigger the bugs by default
- No Sentry/Slack/Datadog credentials needed for local UI testing
- Custom verticals display errors as bottom-right toast notifications (not red error boxes)
- Custom vertical HTML pages are pixel-perfect clones of real public sites — use hotlinked images where possible, fall back to Unsplash with `onerror` handlers when CDNs block hotlinking
- Image CDNs that block hotlinking (403): marriott.com, cache.marriott.com, seb.se. CDNs that allow it: jpmorganchase.com, Unsplash
- When replacing images with Unsplash alternatives, always visually verify the image matches the expected subject (city, building, etc.) — Unsplash photo IDs are opaque and cannot be trusted by name alone
- For Devin session triggering to work on production, the EC2 `.env` must have `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and either the global `DEVIN_SERVICE_KEY` or per-customer keys (e.g. `DEVIN_SERVICE_KEY_BEB4D43E`)
