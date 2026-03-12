#!/usr/bin/env node

/**
 * Demo Warmup Script
 * Runs 15 minutes of traffic to populate dashboards before a demo.
 */

const axios = require('axios');

const TARGET = process.env.LOADGEN_TARGET_URL || 'http://localhost:3000';
const WARMUP_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const CYCLE_INTERVAL_MS = 30 * 1000; // every 30 seconds

const PERSONAS = ['buyer_1', 'buyer_2', 'admin_ops'];
const QUERIES = ['widget', 'gadget', 'tool', 'premium', 'pro'];
const REGIONS = ['US', 'EU', 'UK', 'CA'];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function sendRequest(method, path, data) {
  try {
    await axios({ method, url: `${TARGET}${path}`, data, timeout: 10000 });
  } catch (_err) {
    // Ignore errors during warmup
  }
}

async function warmupCycle(cycleNum) {
  console.log(`[warmup] Cycle ${cycleNum}...`);

  const promises = [];

  // 4 search requests
  for (let i = 0; i < 4; i++) {
    promises.push(sendRequest('get', `/search?q=${randomFrom(QUERIES)}&persona=${randomFrom(PERSONAS)}`));
  }

  // 2 login requests
  for (let i = 0; i < 2; i++) {
    const persona = randomFrom(PERSONAS);
    promises.push(sendRequest('post', '/login', { username: `${persona}@acme.com`, persona }));
  }

  // 1 order lookup
  promises.push(sendRequest('get', `/orders/ord_demo_00${Math.ceil(Math.random() * 3)}?persona=${randomFrom(PERSONAS)}`));

  // 2 checkout requests
  for (let i = 0; i < 2; i++) {
    promises.push(sendRequest('post', '/checkout', {
      userId: `usr_${randomFrom(['buyer_1', 'buyer_2'])}_acme`,
      subtotal: 19.99 + Math.random() * 70,
      region: randomFrom(REGIONS),
      persona: randomFrom(['buyer_1', 'buyer_2']),
    }));
  }

  await Promise.all(promises);
}

async function main() {
  console.log(`[warmup] Starting ${WARMUP_DURATION_MS / 60000}-minute warmup against ${TARGET}`);

  // Verify target is up
  try {
    await axios.get(`${TARGET}/health`, { timeout: 5000 });
  } catch (error) {
    console.error(`[warmup] Target not reachable: ${error.message}`);
    process.exit(1);
  }

  const startTime = Date.now();
  let cycle = 0;

  while (Date.now() - startTime < WARMUP_DURATION_MS) {
    cycle++;
    await warmupCycle(cycle);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.round((WARMUP_DURATION_MS - (Date.now() - startTime)) / 1000);
    console.log(`[warmup] Elapsed: ${elapsed}s, Remaining: ${remaining}s`);
    await new Promise((resolve) => setTimeout(resolve, CYCLE_INTERVAL_MS));
  }

  console.log(`[warmup] Complete. Sent ${cycle} cycles of traffic.`);
}

main().catch((error) => {
  console.error('[warmup] Fatal:', error.message);
  process.exit(1);
});
