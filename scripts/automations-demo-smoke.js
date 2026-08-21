const axios = require('axios');

const baseUrl = (process.env.AUTOMATIONS_DEMO_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`)
  .replace(/\/+$/, '');
const token = process.env.AUTOMATIONS_DEMO_TOKEN;

async function main() {
  const headers = token ? { 'x-automations-demo-token': token } : {};
  const response = await axios.post(`${baseUrl}/api/automations-demo/smoke`, {}, {
    headers,
    timeout: 21 * 60 * 1000,
  });
  if (!response.data.ok) {
    throw new Error(response.data.error || 'Automations demo smoke failed');
  }
  process.stdout.write(`${JSON.stringify(response.data)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Automations demo smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
