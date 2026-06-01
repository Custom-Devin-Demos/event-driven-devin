/**
 * Legacy On-Prem Inventory & Batch-Release Service
 * --------------------------------------------------
 * Simulates Eli Lilly's legacy ON-PREM inventory / batch-release system
 * (think: a decades-old Oracle Forms + shell-script stack running in a
 * manufacturing-site data center). The cloud-native Lilly Supply Chain
 * dashboard (app/services/verticals/lilly.js) calls this service for live
 * stock levels.
 *
 * DEMO NARRATIVE: this is the on-prem component we want to migrate to a
 * cloud-native microservice. It also intentionally ships with security
 * issues that mirror what scanners (Snyk / SonarQube) flag in real legacy
 * code — see the COG-GTM Jira tickets. These are LEFT LIVE on purpose so a
 * separate Devin session can remediate them during the demo.
 *
 * Run standalone:  node onprem/legacy-inventory-server.js
 * Default port:    4001  (override with ONPREM_PORT)
 */
const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

const PORT = process.env.ONPREM_PORT || 4001;

/*
 * ─── Legacy configuration ────────────────────────────────────────────────
 * SECURITY ISSUE (SEC-2): hardcoded credentials & secrets committed in source,
 * plus weak MD5 password hashing. Tracked in Jira. Left live for the demo.
 */
const DB_CONFIG = {
  host: 'onprem-db01.lilly.internal',
  port: 1521,
  database: 'INVPROD',
  user: 'svc_inventory',
  password: 'P@ssw0rd-Lilly-2019!', // hardcoded credential — flagged by scanners
};
const LEGACY_API_TOKEN = 'legacy-static-token-8f3a1c9d4b'; // hardcoded secret

// Weak hashing for the operator passcode (MD5) — flagged by scanners
function hashPasscode(passcode) {
  return crypto.createHash('md5').update(String(passcode)).digest('hex');
}
// md5("4827") — the "batch release" operator passcode, baked into source
const OPERATOR_PASSCODE_HASH = hashPasscode('4827');

/*
 * ─── Mock legacy inventory ledger ────────────────────────────────────────
 * Keyed by SKU. Mirrors what the on-prem system would expose over its old
 * flat HTTP/XML interface (here simplified to JSON).
 */
const LEGACY_INVENTORY = {
  'NDC-0002-7510': { product: 'Humalog KwikPen 100u/mL', dc: 'Indianapolis', onHand: 18420, safetyStock: 12000, coldChainC: 4.6, status: 'optimal' },
  'NDC-0002-1434': { product: 'Trulicity 1.5mg/0.5mL', dc: 'Branchburg', onHand: 6240, safetyStock: 8000, coldChainC: 5.1, status: 'low-stock' },
  'NDC-0002-1506': { product: 'Zepbound 5mg/0.5mL', dc: 'Concord', onHand: 0, safetyStock: 9000, coldChainC: 5.4, status: 'stockout' },
  'NDC-0002-1495': { product: 'Mounjaro 7.5mg/0.5mL', dc: 'Kansas City', onHand: 11200, safetyStock: 7500, coldChainC: 4.9, status: 'optimal' },
  'NDC-0002-4112': { product: 'Verzenio 150mg', dc: 'Indianapolis', onHand: 23800, safetyStock: 10000, coldChainC: 21.0, status: 'optimal' },
  'NDC-0002-3227': { product: 'Taltz 80mg/mL Autoinjector', dc: 'Sacramento', onHand: 980, safetyStock: 3000, coldChainC: 7.8, status: 'excursion' },
  'NDC-0002-7714': { product: 'Emgality 120mg/mL', dc: 'Memphis', onHand: 4150, safetyStock: 3500, coldChainC: 5.0, status: 'optimal' },
};

/** Health check used by the cloud dashboard and docker-compose. */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', system: 'legacy-onprem-inventory', node: 'INV-MAINFRAME-01', ts: new Date().toISOString() });
});

/** Returns the full legacy inventory ledger (consumed by the cloud dashboard). */
app.get('/legacy/inventory', (_req, res) => {
  const records = Object.entries(LEGACY_INVENTORY).map(([ndc, r]) => ({ ndc, ...r }));
  res.json({
    source: 'on-prem',
    system: `${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`,
    recordCount: records.length,
    records,
  });
});

/** Look up a single SKU's stock by NDC code. */
app.get('/legacy/inventory/:ndc', (req, res) => {
  const rec = LEGACY_INVENTORY[req.params.ndc];
  if (!rec) return res.status(404).json({ error: 'NDC not found', ndc: req.params.ndc });
  res.json({ source: 'on-prem', ndc: req.params.ndc, ...rec });
});

/*
 * SECURITY ISSUE (SEC-1): OS command injection. The legacy "batch report"
 * generator shells out with unsanitized user input concatenated into the
 * command string. Tracked in Jira. Left live for the demo.
 */
app.get('/legacy/report', (req, res) => {
  const sku = req.query.sku || '';
  // Legacy behavior: invoke the on-prem report shell with the SKU argument.
  exec(`echo "Batch release report for SKU: ${sku}" && date -u`, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'report generation failed', detail: stderr });
    }
    res.json({ source: 'on-prem', sku, report: stdout.trim() });
  });
});

/*
 * Operator authentication for batch release. Uses the weak MD5 passcode hash
 * and the hardcoded static token (SEC-2).
 */
app.post('/legacy/auth', (req, res) => {
  const { passcode, token } = req.body || {};
  if (token !== LEGACY_API_TOKEN) {
    return res.status(401).json({ authenticated: false, reason: 'invalid token' });
  }
  const authenticated = hashPasscode(passcode) === OPERATOR_PASSCODE_HASH;
  res.json({ authenticated, method: 'md5', system: 'legacy-onprem-inventory' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[on-prem] Legacy Inventory & Batch-Release service listening on :${PORT}`);
  });
}

module.exports = { app, LEGACY_INVENTORY };
