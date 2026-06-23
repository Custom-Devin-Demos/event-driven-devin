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
1. Add the slug to `config/customers.js`:
   ```js
   '<slug>': {
     label: 'Customer <PREFIX>',
     triggerMode: 'api',
   },
   ```
2. Add env vars to `docker-compose.yml`:
   ```yaml
   - DEVIN_SERVICE_KEY_<SLUG_UPPER>=${DEVIN_SERVICE_KEY_<SLUG_UPPER>:-}
   - DEVIN_USER_ID_<SLUG_UPPER>=${DEVIN_USER_ID_<SLUG_UPPER>:-}
   ```
3. Add env vars to `.env.example`:
   ```bash
   # Customer <slug>
   # DEVIN_SERVICE_KEY_<SLUG_UPPER>=
   # DEVIN_USER_ID_<SLUG_UPPER>=
   ```

### Step 6: Mount the Route
Add the route to `app/routes/verticals/index.js`:
```js
const <slug>Routes = require('./<slug>');
router.use('/', <slug>Routes);
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
- [ ] Customer slug exists in `config/customers.js` with `triggerMode: 'api'`
- [ ] Per-customer env vars listed in both `docker-compose.yml` AND `.env.example`
- [ ] Route is mounted in `app/routes/verticals/index.js`
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

### Step 2: Rebuild and Restart the Container
```bash
ssh -i /tmp/ec2_key ubuntu@<EC2_IP> bash -s <<'RESTART'
cd /home/ubuntu
docker compose up -d --build --no-deps checkout-api

# Wait for health check
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health || true)
  [ "$STATUS" = "200" ] && echo "Healthy on attempt $i" && break
  sleep 2
done
RESTART
```

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

# Custom — United Airlines (4ada28b9)
curl -s -X POST http://localhost:3000/api/4ada28b9/search-flights -H 'Content-Type: application/json' -d '{"origin":"EWR","destination":"LAX","cabin":"economy","passengers":1,"devinUserId":"clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV","devinOrgId":"org-2cd0ade21d8d4c5886fcea1b701c34e0"}'
```

## Common Issues & Troubleshooting

### EC2 env vars are empty after deployment
The deploy GitHub Action copies code but does NOT update `.env`. Per-customer env vars (`DEVIN_SERVICE_KEY_<SLUG>`, `DEVIN_USER_ID_<SLUG>`) must be added manually via SSH. If the Slack alert posts but no Devin session is created, this is almost always the cause — check with:
```bash
docker exec ubuntu-checkout-api-1 env | grep '<SLUG_UPPER>'
```

### Git pull fails on EC2 (no credentials)
The EC2 host may not have git credentials configured. If `git pull` fails with "could not read Username", use SCP to copy changed files directly:
```bash
scp -i ~/.ssh/ec2_key <local-file> ubuntu@<EC2_IP>:/home/ubuntu/<path>
```
Then rebuild the container with `docker compose up -d --build checkout-api`.

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
