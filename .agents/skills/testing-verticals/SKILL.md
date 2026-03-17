# Testing Event-Driven Devin Verticals

## Prerequisites
- Run `npm install` in repo root
- Start the server: `node app/server.js` (runs on port 3000)

## Hub Landing Page
- Visit `http://localhost:3000/` to see all 9 vertical demo cards
- Each card links to its vertical URL

## Testing Each Vertical

For each vertical, navigate to its URL, fill the form (defaults are pre-populated to trigger the bug), and click the submit button. Verify the error message appears in a red error box.

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
```

## Notes
- All bugs are intentional — they are designed to trigger the Sentry/Slack/Devin investigation pipeline
- Each bug has a root cause in a different function from where the crash occurs
- The frontends pre-populate form values that trigger the bugs by default
- No Sentry/Slack/Datadog credentials needed for local UI testing
