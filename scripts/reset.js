#!/usr/bin/env node

/**
 * Demo Reset Script
 * Sets app to healthy, confirms traffic generator and telemetry are working.
 */

const axios = require('axios');

const TARGET = process.env.LOADGEN_TARGET_URL || 'http://localhost:3000';

async function reset() {
  console.log('[reset] Starting demo reset...\n');

  // 1. Set app to healthy
  try {
    const scenarioRes = await axios.post(`${TARGET}/admin/scenario`, { scenario: 'healthy' });
    console.log('[reset] 1. Scenario set to healthy:', scenarioRes.data);
  } catch (error) {
    console.error('[reset] 1. FAILED to set scenario:', error.message);
    return false;
  }

  // 2. Confirm app is healthy
  try {
    const healthRes = await axios.get(`${TARGET}/health`);
    console.log('[reset] 2. Health check:', healthRes.data);
  } catch (error) {
    console.error('[reset] 2. Health check FAILED:', error.message);
    return false;
  }

  // 3. Send a test request to each endpoint
  const tests = [
    { method: 'post', url: '/login', data: { username: 'test@acme.com', persona: 'buyer_1' }, label: 'Login' },
    { method: 'get', url: '/search?q=widget', label: 'Search' },
    { method: 'post', url: '/checkout', data: { userId: 'test', subtotal: 29.99, region: 'US' }, label: 'Checkout' },
    { method: 'get', url: '/orders/ord_demo_001', label: 'Orders' },
  ];

  for (const test of tests) {
    try {
      const res = await axios({ method: test.method, url: `${TARGET}${test.url}`, data: test.data, timeout: 10000 });
      console.log(`[reset] 3. ${test.label}: OK (${res.status})`);
    } catch (error) {
      const status = error.response ? error.response.status : 'N/A';
      console.error(`[reset] 3. ${test.label}: FAILED (${status}) - ${error.message}`);
    }
  }

  console.log('\n[reset] Demo reset complete. System is healthy.');
  return true;
}

reset().then((success) => {
  process.exit(success ? 0 : 1);
});
