---
name: testing-verticals
description: Create and test Event-Driven Devin industry verticals end-to-end. Use when adding new custom demo verticals or verifying existing ones.
---

# Creating & Testing Event-Driven Devin Verticals

This playbook covers the **full lifecycle** of creating and deploying custom demo verticals — from cloning a public site to verifying Devin sessions trigger on production. Every step is mandatory unless marked optional.

## Prerequisites
- Run `npm install` in repo root
- Start the server: `node app/server.js` (runs on port 3000)
- For EC2 deployment: `EC2_SSH_KEY` secret must be available

---

## Part 1: Creating a New Custom Vertical

### Step 1: Generate a Hex Slug
```bash
node -e "console.log(require('crypto').randomBytes(4).toString('hex'))"
```
This produces a slug like `beb4d43e` used as the URL path, route prefix, and config key.

### Step 2: Clone the Public Site (Pixel-Perfect)
1. Open the real public site in the browser
2. Extract exact CSS values using `getComputedStyle()` — do NOT eyeball colors, fonts, or spacing
3. Create `app/public/verticals/<slug>.html` matching the live site exactly
4. Use the real site's CDN images first. Test hotlinkability with curl:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" "<image-url>"
   ```
5. If the CDN returns 403 (blocks hotlinking), use Unsplash alternatives instead
6. For ANY non-Unsplash image, add an `onerror` fallback:
   ```html
   <img src="https://realsite.com/image.jpg"
        onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-xxx?w=800&q=80';"
        alt="Description">
   ```

#### Image Verification (CRITICAL — do not skip)
For every image in the HTML file:
1. **HTTP check**: `curl -s -o /dev/null -w "%{http_code}" "<url>"` — must return 200
2. **Visual check**: Open the image URL directly in the browser and confirm it shows the correct subject
   - Unsplash photo IDs are opaque — `photo-1582167751370` tells you nothing about the content
   - A URL returning 200 does NOT mean it shows the right city/person/building
3. **Crop check**: After loading the page, verify images are properly framed:
   - Hero portraits must show face and upper body, not just the top of the head
   - City images must show recognizable landmarks, not generic skylines
   - `object-position: center top` crops from the top — use `center center` for portraits
4. **Side-by-side check**: Open the real site and the clone side-by-side, confirm they match

**Known CDN hotlinking behavior:**
| CDN | Hotlinking | Notes |
|-----|-----------|-------|
| Unsplash (`images.unsplash.com`) | Allowed | Preferred fallback source |
| fedex.com (`www.fedex.com/content/dam/`) | Allowed | FedEx CDN images hotlink fine |
| kochinc.com (SVG logos) | Allowed | Koch logo SVGs load directly |
| kochind.scene7.com | Blocked (403) | Koch scene7 images blocked; use Unsplash fallbacks |
| jpmorganchase.com | Allowed | Can hotlink directly |
| Optimizely (`cdn.optimizely.com`) | Allowed | Images hotlink fine; some are pre-rendered promotional blocks |
| marriott.com / cache.marriott.com | Blocked (403) | Must use Unsplash alternatives |
| seb.se | Blocked (403) | Must use Unsplash alternatives |

### Step 3: Create the Route File
Create `app/routes/verticals/<slug>.js` following the pattern of existing verticals (e.g., `beb4d43e.js`):
- Serve the HTML page on `GET /<slug>`
- Create a POST endpoint (e.g., `POST /api/<slug>/inquiry`)
- Extract `devinUserId`, `devinOrgId`, and `devinEmail` from `req.body` and pass to the service

### Step 4: Create the Service File
Create `app/services/verticals/<slug>.js` following existing patterns:
- Include an intentional TypeError bug in the business logic
- In the `catch` block, call `createSessionAndAlert()` with:
  ```js
  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    customer: '<slug>',
    devinUserId: data.devinUserId,
    devinOrgId: data.devinOrgId,
    devinEmail: data.devinEmail,
    slackMemberId: '<slack-member-id>',
    // ... other required fields
  })
  ```
- Verify `customer: '<slug>'` is passed — this routes to the correct per-customer config

### Step 5: Register the Customer
Create `config/customers/<slug>.js` (one file per customer — do NOT edit `config/customers.js`):
```js
module.exports = {
  label: 'Customer <PREFIX>',
  triggerMode: 'api',
  // aliases: ['friendly-name'],   // optional: also serve the page at /friendly-name
};
```
Document the env vars in `.env.example` (the production `.env` is loaded wholesale via `env_file`, so `docker-compose.yml` needs no change):
```bash
# Customer <slug>
# DEVIN_SERVICE_KEY_<SLUG_UPPER>=
# DEVIN_USER_ID_<SLUG_UPPER>=
```

### Step 6: Mount the Route
Nothing to do. `app/routes/verticals/index.js` discovers and mounts every `app/routes/verticals/<slug>.js` and serves every `app/public/verticals/<slug>.html` at `/<slug>` on boot. Do NOT edit `index.js` — two source repos deploy to the same host, and hand-edits to shared files are what used to unregister other customers' demos. Verify wiring with:
```bash
npx jest tests/verticals-registry.test.js
```

### Step 7: Wire the Frontend CTA
The HTML file's CTA button must send a POST with:
```js
fetch('/api/<slug>/inquiry', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    // business-specific fields...
    devinUserId: '<clerk-user-id>',
    devinOrgId: '<org-id>',
    devinEmail: localStorage.getItem('devinEmail') || '',
  }),
})
```

---

## Part 2: Pre-PR Verification (MANDATORY — do not submit PR without completing)

### Checklist A: Visual Verification
- [ ] Start the local server (`node app/server.js`)
- [ ] Open each new/modified vertical page in the browser
- [ ] Verify ALL images load (no broken image icons)
- [ ] Verify hero/key images are properly framed (not cropped — faces visible, cities recognizable)
- [ ] Open the real public site side-by-side and confirm clone is pixel-perfect
- [ ] Take a full-page screenshot of each vertical (use Puppeteer `take-screenshot` command)
- [ ] Include screenshots in the PR description

### Checklist B: Image URL Validation
- [ ] Extract every `src=` URL from the HTML file
- [ ] Run `curl -s -o /dev/null -w "%{http_code}"` against each — all must return 200
- [ ] Open each image URL directly in browser — confirm it shows the correct subject
- [ ] For non-Unsplash sources, verify `onerror` fallback is present

### Checklist C: Functional Verification
- [ ] Click the CTA button on each vertical in the browser
- [ ] Verify the error toast/message appears with the correct TypeError text
- [ ] Verify toast auto-dismisses after ~6 seconds (for custom verticals)
- [ ] Check server terminal logs for `"Posting alert and triggering Devin"` log line
- [ ] Verify the curl API endpoint returns 500 with the expected error JSON

### Checklist D: Code Verification
- [ ] Service file catch block calls `createSessionAndAlert()` with `customer: '<slug>'`
- [ ] Frontend sends `devinUserId` and `devinOrgId` in the POST body
- [ ] `config/customers/<slug>.js` exists with `triggerMode: 'api'`
- [ ] Per-customer env vars documented in `.env.example`
- [ ] `app/routes/verticals/index.js`, `config/customers.js`, and `docker-compose.yml` are NOT modified
- [ ] `npx jest tests/verticals-registry.test.js` passes
- [ ] `npm run lint` passes (0 errors)

---

## Part 3: Post-Merge EC2 Deployment (MANDATORY)

After the PR is merged, you MUST update the EC2 production deployment:

### Step 1: Add Per-Customer Env Vars to EC2
SSH into EC2 and add the per-customer env vars to `/home/ubuntu/.env`:
```bash
ssh -i /tmp/ec2_key -o StrictHostKeyChecking=no ubuntu@$(ping -c1 devindemos.com 2>/dev/null | grep -oP '\d+\.\d+\.\d+\.\d+' | head -1) bash -s <<'DEPLOY'
cd /home/ubuntu
cp .env .env.bak.$(date +%s)

# Add per-customer vars (use the same service key and user ID as existing customers)
# Check existing values:
#   grep 'DEVIN_SERVICE_KEY_ACF4303D' .env   (for the service key)
#   grep 'DEVIN_USER_ID_F2F54159' .env       (for Russell's user ID)
# Then add for each new slug:
grep -q 'DEVIN_SERVICE_KEY_<SLUG_UPPER>' .env || echo 'DEVIN_SERVICE_KEY_<SLUG_UPPER>=<service-key-value>' >> .env
grep -q 'DEVIN_USER_ID_<SLUG_UPPER>' .env || echo 'DEVIN_USER_ID_<SLUG_UPPER>=<user-id-value>' >> .env

echo "Verifying..."
grep '<SLUG_UPPER>' .env
DEPLOY
```

### Step 2: Let CI deploy the code, then restart for the new env vars
Do **not** copy/extract code onto the host yourself. Merging to `main` runs the
`Deploy to EC2` workflow, which hands the tree to `scripts/deploy-ec2.sh` on the
host (lock, backup, mirror without deleting other verticals, health + smoke of
every slug, rollback on failure). Wait for that run to go green
(`git_pr_checks` / the Actions tab), then restart `checkout-api` so it picks up
the `.env` additions from Step 1:
```bash
ssh -i /tmp/ec2_key ubuntu@<EC2_IP> bash -s <<'RESTART'
cd /home/ubuntu
docker compose up -d --no-deps checkout-api
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health || true)
  [ "$STATUS" = "200" ] && echo "Healthy on attempt $i" && break
  sleep 2
done
RESTART
```
If the workflow is red (or its secrets are missing in this repo), run the manual
path in AGENTS.md "EC2 Redeploy Steps" — it uses the same script.

### Step 3: Verify Env Vars in Container
```bash
ssh -i /tmp/ec2_key ubuntu@<EC2_IP> \
  "docker exec ubuntu-checkout-api-1 env | grep '<SLUG_UPPER>' | sed 's/=.*/=<SET>/'"
```
All per-customer vars must show `=<SET>`.

### Step 4: Verify Devin Session Triggering on Production
```bash
ssh -i /tmp/ec2_key ubuntu@<EC2_IP> \
  'curl -s -X POST http://localhost:3000/api/<slug>/inquiry \
   -H "Content-Type: application/json" \
   -d "{\"property\":\"test\",\"devinUserId\":\"<user-id>\",\"devinOrgId\":\"<org-id>\"}"'
```
Then check container logs:
```bash
ssh -i /tmp/ec2_key ubuntu@<EC2_IP> \
  "docker logs ubuntu-checkout-api-1 --tail 20 2>&1 | grep -E 'alert|session|Devin'"
```
You MUST see ALL of these log lines:
1. `"Resolved customer-specific Devin config"` with `hasApiKey: true`
2. `"Posting alert and triggering Devin"`
3. `"Alert posted to Slack"`
4. `"Devin session created via v3 API"` with a session ID
5. `"Devin session link posted to Slack thread"`

If any are missing, debug before reporting completion.

### Step 5: Verify on Public URL
Open `https://devindemos.com/<slug>` in the browser and:
- [ ] Confirm the page loads with correct images and layout
- [ ] Click the CTA button
- [ ] Verify the error toast appears
- [ ] Check Slack channel for the alert message with "View in Devin" button

---

## Part 4: Testing Reference

### Hub Landing Page
- Visit `http://localhost:3000/` to see all vertical demo cards
- Each card links to its vertical URL

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
| Taco Bell | `/tacobell` | Click "Proceed to Checkout" (Rewards Tier defaults to "Fire!") | `Cannot read properties of undefined (reading 'pointsMultiplier')`; switch tier to "Hot" → success; empty bag → 400 EmptyBagError |

### Custom Customer Verticals

Custom verticals use hex-slug URLs. Errors display as a bottom-right toast notification that auto-dismisses after ~6 seconds.

| Customer | URL | CTA Button | Expected Error |
|----------|-----|------------|----------------|
| Marriott (beb4d43e) | `/beb4d43e` | "Book Now" | `Cannot read properties of undefined (reading 'available')` |
| SEB (4feeb7bb) | `/4feeb7bb` | "Aktuella bolåneräntor" | `Cannot read properties of undefined (reading 'riskPremium')` |
| JPMC (89c1f355) | `/89c1f355` | "Join our team →" | `Cannot read properties of undefined (reading 'totalHeadcount')` |
| FedEx (17dd6f6f) | `/17dd6f6f` | "LEARN MORE" | `Cannot read properties of undefined (reading 'start')` |
| Koch Industries (08381313) | `/08381313` | "Get to know Koch" | `Cannot read properties of undefined (reading 'lastAuditDate')` |
| United Airlines (4ada28b9) | `/4ada28b9` | "Find flights" | `Cannot read properties of undefined (reading 'milesMultiplier')` |
| RBC Royal Bank (3cec99d4) | `/3cec99d4`, `/rbc` | "Apply Online Now" (student chequing card, school email left blank) | `Cannot read properties of undefined (reading 'toLowerCase')` |
| Citi Self Invest (94f4c31f) | `/94f4c31f`, `/citi` | "Continue" (form pre-fills a 65+ DOB `06/15/1958` — senior suitability band missing from policy map; error shows in inline red panel, not a toast; DOB under 65 e.g. `05/14/1990` → green success panel; blank/malformed DOB → 400 ValidationError panel, no alert) | `Cannot read properties of undefined (reading 'reviewTrack')` |
| Capital One Travel (b014618f) | `/b014618f`, `/capitalone` | "Book now" (Venture X card selected by default — its `venture_x_premium` rewards program is missing from the redemption map; error shows in an inline red panel, not a toast; selecting Venture or SavorOne → green confirmation panel) | `Cannot read properties of undefined (reading 'milesIncrement')` |
| U.S. Bank Business Bill Pay (4f9ede2a) | `/4f9ede2a`, `/usbank` | "Pay" on the SwiftHost Web Services row ($2,876.00 routes onto the same-day ACH rail, which has no remittance format registered; error shows in an inline red panel below the table; rows under $2,500 e.g. ABC Print → green confirmation panel; vendors with no unpaid bills → 400 ValidationError panel, no alert) | `Cannot read properties of undefined (reading 'railName')` |
| The Home Depot (a69bcc34) | `/a69bcc34`, `/homedepot` | "Checkout" (cart with the `HDCC25` promo code applied) | `Cannot read properties of undefined (reading 'freeThreshold')` |
| QBE North America Claims (qbe) | `/qbe` | "Submit Claim" (QBE-PA-4417293 collision claim) | `Cannot read properties of undefined (reading 'collisionDeductible')` |
| NAB Internet Banking (nab) | `/nab` | "Pay now" (082-001 40817266 Pay Anyone payment) | `Cannot read properties of undefined (reading 'dailyLimit')` |

### API Testing (curl)

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

# Custom — Marriott (beb4d43e)
curl -s -X POST http://localhost:3000/api/beb4d43e/inquiry -H 'Content-Type: application/json' -d '{"property":"maui","roomType":"suite","priority":"standard"}'

# Custom — SEB (4feeb7bb)
curl -s -X POST http://localhost:3000/api/4feeb7bb/inquiry -H 'Content-Type: application/json' -d '{"loanType":"mortgage","region":"stockholm","rateType":"variable"}'

# Custom — JPMC (89c1f355)
curl -s -X POST http://localhost:3000/api/89c1f355/inquiry -H 'Content-Type: application/json' -d '{"division":"investment-banking","region":"north-america","assetClass":"equities"}'

# Custom — FedEx (17dd6f6f)
curl -s -X POST http://localhost:3000/api/17dd6f6f/track-shipment -H 'Content-Type: application/json' -d '{"trackingNumber":"FX-7829104563"}'

# Custom — Koch Industries (08381313)
curl -s -X POST http://localhost:3000/api/08381313/supply-inquiry -H 'Content-Type: application/json' -d '{"companyId":"KII-9204715"}'

# Custom — RBC Royal Bank (3cec99d4)
curl -s -X POST http://localhost:3000/api/3cec99d4/open-account -H 'Content-Type: application/json' -d '{"productCode":"ADV-STUDENT-CHQ","applicantType":"student-full-time","promoCode":"STUDENT-AIRPODS-2026","schoolEmail":"","province":"ON","devinUserId":"clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV","devinOrgId":"org_69IXJFLrljx8zSAw"}'

# Custom — Citi Self Invest (94f4c31f) — 65+ DOB triggers TypeError (missing 'senior' suitability band); blank/malformed DOB → 400 ValidationError (no alert); GET /api/94f4c31f/products lists products
curl -s -X POST http://localhost:3000/api/94f4c31f/personal-info -H 'Content-Type: application/json' -d '{"firstName":"Margaret","lastName":"Chen","dateOfBirth":"06/15/1958","devinUserId":"clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV","devinOrgId":"org_69IXJFLrljx8zSAw"}'

# Custom — U.S. Bank Business Bill Pay (4f9ede2a) — high-value vendor triggers TypeError (same-day ACH rail missing a remittance format); sub-$2,500 vendors succeed; vendors with no unpaid bills → 400 ValidationError (no alert)
curl -s -X POST http://localhost:3000/api/4f9ede2a/pay -H 'Content-Type: application/json' -d '{"vendorId":"swifthost-web","devinUserId":"clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV","devinOrgId":"org_69IXJFLrljx8zSAw"}'

# Custom — The Home Depot (a69bcc34)
curl -s -X POST http://localhost:3000/api/a69bcc34/checkout -H 'Content-Type: application/json' -d '{"items":[{"sku":"1005643790","qty":1,"fulfillment":"delivery"}],"promoCode":"HDCC25","storeNumber":"6177","zipCode":"10010","devinUserId":"clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV","devinOrgId":"org_69IXJFLrljx8zSAw"}'

# Custom — QBE North America Claims (qbe)
curl -s -X POST http://localhost:3000/api/qbe/claim -H 'Content-Type: application/json' -d '{"policyNumber":"QBE-PA-4417293","incidentType":"collision","incidentDate":"2026-08-21","damageDescription":"Front-end damage after a collision","vin":"1HGCV1F34LA015872"}'

# Custom — NAB Internet Banking (nab) — default 082-001 40817266 (everyday_global_2026) has no payment-limit
# schedule → TypeError 500 PAYMENT_SETTLEMENT_FAILED; 082-001 14872931 (Classic, $20k limit) → Osko success;
# 082-001 22059347 (iSaver, $5k limit, 24h hold) → Direct Entry success; paymentMethod "bpay" forces Direct Entry.
# Validation 400s (no alert): amount > balance, amount <= 0, missing payeeName/payeeBsb/payeeAccount/payId/billerCode.
# GET /api/nab/accounts lists the three accounts.
curl -s -X POST http://localhost:3000/api/nab/payment -H 'Content-Type: application/json' -d '{"fromAccount":"082-001 40817266","paymentMethod":"pay_anyone","payeeName":"Harper Electrical Services","payeeBsb":"083-004","payeeAccount":"55910238","amount":1250,"description":"Invoice 2261","channel":"web"}'

# Custom — Capital One Travel (b014618f) — venture-x triggers TypeError; venture/savorone succeed
curl -s -X POST http://localhost:3000/api/b014618f/redeem-miles -H 'Content-Type: application/json' -d '{"cardProduct":"venture-x","bookingType":"hotel","tripTotalUsd":1284.50,"milesApplied":90000,"devinUserId":"clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV","devinOrgId":"org_69IXJFLrljx8zSAw"}'

# Custom — United Airlines (4ada28b9)
curl -s -X POST http://localhost:3000/api/4ada28b9/search-flights -H 'Content-Type: application/json' -d '{"origin":"EWR","destination":"LAX","cabin":"economy","passengers":1,"devinUserId":"clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV","devinOrgId":"org-2cd0ade21d8d4c5886fcea1b701c34e0"}'
```

## Common Issues & Troubleshooting

### EC2 env vars are empty after deployment
The deploy GitHub Action copies code but does NOT update `.env`. Per-customer env vars (`DEVIN_SERVICE_KEY_<SLUG>`, `DEVIN_USER_ID_<SLUG>`) must be added manually via SSH. If the Slack alert posts but no Devin session is created, this is almost always the cause — check with:
```bash
docker exec ubuntu-checkout-api-1 env | grep '<SLUG_UPPER>'
```

### Slack alert posts but Devin session creation 403s (`org.devins.use`)
If `Alert posted to Slack` appears but `Devin session created via v3 API` does not, and the container logs
`Failed to create Devin session via v3 API` with `status: 403` and
`detail: "Missing required permission 'org.devins.use' on this organization"` against
`/v3/organizations/<devinOrgId>/sessions`, the per-customer key/user/org triple is mismatched — not missing.
`hasApiKey: true` / `hasDevinUserId: true` proves only that env vars exist; it does **not** prove the key works,
so always grep for the session-creation line itself.

Two things to check, in this order:
1. **Do not hard-code `devinUserId` in the vertical HTML.** A stale `clerk-user_...` value in
   `app/public/verticals/<slug>.html` overrides the env var. Send `var DEVIN_USER_ID = '';` so
   `app/services/devin-session.js` falls back to `config.devinUserId` (= `DEVIN_USER_ID_<SLUG>`).
   A healthy run logs `devinUserId: "none"` on `Posting alert and triggering Devin` and the resolved
   `clerk-user_...` on `Devin session created and linked in Slack thread`.
2. **Point `DEVIN_SERVICE_KEY_<SLUG>` / `DEVIN_USER_ID_<SLUG>` at a key/user pair authorized on the
   `devinOrgId` in the HTML.** Not every key on the host has `org.devins.use` on every org — copy the pair
   from a vertical whose session creation is known to work. Back up `/home/ubuntu/.env` before editing,
   then `docker compose up -d --build checkout-api`.

Beware the masking fallback: the Sentry webhook path can independently create sessions as
`customer: "default"` / `userId: "service-user"` ~20-30s later (and can deliver twice, producing duplicate
"View in Devin" replies in the thread). Grep both paths and match on `customer` before declaring health:
```bash
docker logs ubuntu-checkout-api-1 --since 10m 2>&1 | grep -E "Resolved customer-specific|Posting alert|Alert posted|Devin session|Failed to create Devin|Sentry webhook received"
```
Counting `"sessionId":"..."` occurrences (`| grep -oE '"sessionId":"[0-9a-f]+"' | sort -u`) is the quickest way
to prove exactly one session came out of one click.

### Git pull fails on EC2 (no credentials)
The EC2 host may not have git credentials configured. If `git pull` fails with "could not read Username", use SCP to copy changed files directly:
```bash
scp -i ~/.ssh/ec2_key <local-file> ubuntu@<EC2_IP>:/home/ubuntu/<path>
```
Then rebuild the container with `docker compose up -d --build checkout-api`.

### `[hidden]` field groups all render at once (multi-tab / multi-method forms)
Verticals whose form has method tabs (e.g. NAB `/nab` Pay Anyone / PayID / BPAY, or any page that toggles
field groups with `element.hidden = true`) can show **every** group at once. The user-agent rule
`[hidden] { display: none }` has lower specificity than a page rule like `.form-row { display: flex }`,
so an explicit `display` on the group's class silently wins and the `hidden` attribute has no visual effect.
The symptom is that clicking a tab only moves the active underline while all payee/biller fields stay visible.

Diagnose from the browser console (attribute is set but computed display is not `none`):
```js
['bank-fields','payid-fields','bpay-fields'].map(function (id) {
  var el = document.getElementById(id);
  return { id: id, hiddenAttr: el.hidden, display: getComputedStyle(el).display };
});
```
The fix is a CSS rule such as `.form-row[hidden] { display: none; }` plus calling the sync function once on
load (not only on tab click), otherwise the initial render leaks the non-default groups.

When testing any tabbed vertical form, always check the field groups **on fresh load** and **after switching
to every tab** — a tab handler that works on click can still leave the first paint wrong.

### Optimizely CDN images are pre-rendered blocks
Some CDN images (e.g., credit card promotional blocks) are complete pre-rendered compositions containing text, badges, and buttons baked into the image. Do NOT duplicate this content with separate HTML elements — use a single `<img>` tag. Adding HTML text on top of such images causes visual duplication and overflow.

### Promo cards overflow hero section
If promotional cards bleed outside the hero section, add `overflow: hidden` to the `.hero` container and ensure the promo card uses `position: absolute` with percentage-based vertical centering (`top: 50%; transform: translateY(-50%)`).

## Notes
- All bugs are intentional — they are designed to trigger the Sentry/Slack/Devin investigation pipeline
- Each bug has a root cause in a different function from where the crash occurs
- The frontends pre-populate form values that trigger the bugs by default
- No Sentry/Slack/Datadog credentials needed for local UI testing
- Custom verticals display errors as bottom-right toast notifications (not red error boxes)
- Custom vertical HTML pages are pixel-perfect clones of real public sites
- EC2 deployment is at `/home/ubuntu/` on the EC2 host (devindemos.com)
- The production `.env` is at `/home/ubuntu/.env` — never overwrite or delete it
- Use the `EC2_SSH_KEY` secret and resolve the IP via `ping -c1 devindemos.com`
- The deploy GitHub Action runs on push to `main` but does NOT update `.env` — per-customer env vars must be added manually via SSH

## Devin Secrets Needed
- `EC2_SSH_KEY`: SSH private key for accessing the EC2 production host
