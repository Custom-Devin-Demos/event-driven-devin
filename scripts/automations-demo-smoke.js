const axios = require('axios');

const DEFAULT_SMOKE_ACCUMULATION_WAIT_MS = 30 * 60 * 1000;
const SMOKE_POLL_WINDOW_MS = 20 * 60 * 1000;
const SMOKE_TIMEOUT_MARGIN_MS = 60 * 1000;
const baseUrl = (process.env.AUTOMATIONS_DEMO_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`)
  .replace(/\/+$/, '');
const token = process.env.AUTOMATIONS_DEMO_TOKEN;

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function main() {
  const headers = token ? { 'x-automations-demo-token': token } : {};
  const accumulationWait = envNumber(
    'AUTOMATIONS_DEMO_SMOKE_ACCUMULATION_WAIT_MS',
    DEFAULT_SMOKE_ACCUMULATION_WAIT_MS,
  );
  const response = await axios.post(`${baseUrl}/api/automations-demo/smoke`, {}, {
    headers,
    timeout: accumulationWait + SMOKE_POLL_WINDOW_MS + SMOKE_TIMEOUT_MARGIN_MS,
    validateStatus: () => true,
  });
  if (!response.data.ok) {
    throw new Error(response.data?.error || `Automations demo smoke failed (HTTP ${response.status})`);
  }
  process.stdout.write(`${JSON.stringify(response.data)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Automations demo smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
