const axios = require('axios');

const TARGET_URL_RAW = process.env.LOADGEN_TARGET_URL || 'http://localhost:3000';
const TARGET_URL = TARGET_URL_RAW.startsWith('http') ? TARGET_URL_RAW : `http://${TARGET_URL_RAW}`;
const INTERVAL_MS = parseInt(process.env.LOADGEN_INTERVAL_MS, 10) || 60000;

const PERSONAS = ['buyer_1', 'buyer_2', 'admin_ops'];

const PERSONA_USER_IDS = {
  buyer_1: 'usr_b1_acme',
  buyer_2: 'usr_b2_acme',
  admin_ops: 'usr_admin_acme',
};

const SEARCH_QUERIES = ['widget', 'gadget', 'tool', 'premium', 'pro', 'mini', 'accessory', 'kit'];

const REGIONS = ['US', 'EU', 'UK', 'CA'];

const ITEMS = [
  { sku: 'WIDGET-001', qty: 1, price: 29.99 },
  { sku: 'WIDGET-002', qty: 2, price: 19.99 },
  { sku: 'GADGET-001', qty: 1, price: 49.99 },
  { sku: 'TOOL-001', qty: 1, price: 89.99 },
  { sku: 'ACC-001', qty: 3, price: 9.99 },
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getTimeMultiplier() {
  const hour = new Date().getUTCHours();
  // Lower overnight (0-6 UTC), moderate daytime (7-18), mild evening (19-23)
  if (hour >= 0 && hour < 6) return 0.3;
  if (hour >= 6 && hour < 9) return 0.6;
  if (hour >= 9 && hour < 18) return 1.0;
  if (hour >= 18 && hour < 21) return 0.8;
  return 0.5;
}

async function makeRequest(method, path, data, label) {
  try {
    const url = `${TARGET_URL}${path}`;
    const config = {
      method,
      url,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'X-Synthetic': 'true' },
    };
    if (data) config.data = data;

    const start = Date.now();
    const response = await axios(config);
    const duration = Date.now() - start;

    console.log(`[loadgen] ${label} => ${response.status} (${duration}ms)`);
    return { success: true, status: response.status, duration };
  } catch (error) {
    const status = error.response ? error.response.status : 0;
    const duration = error.response ? 0 : -1;
    console.log(`[loadgen] ${label} => ERROR ${status} - ${error.message}`);
    return { success: false, status, duration, error: error.message };
  }
}

async function sendSearchRequests(count) {
  const promises = [];
  for (let i = 0; i < count; i++) {
    const persona = randomFrom(PERSONAS);
    const query = randomFrom(SEARCH_QUERIES);
    promises.push(
      makeRequest('get', `/search?q=${query}&persona=${persona}`, null, `SEARCH q=${query} persona=${persona}`)
    );
  }
  return Promise.all(promises);
}

async function sendLoginRequests(count) {
  const promises = [];
  for (let i = 0; i < count; i++) {
    const persona = randomFrom(PERSONAS);
    promises.push(
      makeRequest('post', '/login', { username: `${persona}@acme.com`, password: 'demo', persona }, `LOGIN persona=${persona}`)
    );
  }
  return Promise.all(promises);
}

async function sendOrderLookups(count) {
  const orderIds = ['ord_demo_001', 'ord_demo_002', 'ord_demo_003'];
  const promises = [];
  for (let i = 0; i < count; i++) {
    const orderId = randomFrom(orderIds);
    const persona = randomFrom(PERSONAS);
    promises.push(
      makeRequest('get', `/orders/${orderId}?persona=${persona}`, null, `ORDER id=${orderId} persona=${persona}`)
    );
  }
  return Promise.all(promises);
}

async function sendCheckoutRequests(count) {
  const promises = [];
  for (let i = 0; i < count; i++) {
    const persona = randomFrom(['buyer_1', 'buyer_2']);
    const item = randomFrom(ITEMS);
    const region = randomFrom(REGIONS);
    promises.push(
      makeRequest('post', '/checkout', {
        userId: PERSONA_USER_IDS[persona],
        items: [item],
        subtotal: item.price * item.qty,
        region,
        persona,
      }, `CHECKOUT persona=${persona} region=${region}`)
    );
  }
  return Promise.all(promises);
}

async function runTrafficCycle() {
  const multiplier = getTimeMultiplier();
  const searchCount = Math.max(1, Math.round(6 * multiplier));
  const loginCount = Math.max(1, Math.round(3 * multiplier));
  const orderCount = Math.max(1, Math.round(2 * multiplier));

  console.log(`\n[loadgen] ---- Traffic cycle @ ${new Date().toISOString()} (multiplier: ${multiplier}) ----`);
  const checkoutCount = Math.max(1, Math.round(2 * multiplier));

  console.log(`[loadgen] Sending: ${searchCount} search, ${loginCount} login, ${orderCount} orders, ${checkoutCount} checkout`);

  await sendSearchRequests(searchCount);
  await sendLoginRequests(loginCount);
  await sendOrderLookups(orderCount);
  await sendCheckoutRequests(checkoutCount);

  console.log('[loadgen] ---- Cycle complete ----\n');
}

// Health check on startup
async function checkTarget() {
  try {
    const response = await axios.get(`${TARGET_URL}/health`, { timeout: 5000 });
    console.log(`[loadgen] Target healthy: ${TARGET_URL}`, response.data);
    return true;
  } catch (error) {
    console.error(`[loadgen] Target unreachable: ${TARGET_URL} - ${error.message}`);
    return false;
  }
}

// Main
async function main() {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║     Acme Commerce - Traffic Generator        ║
  ║                                              ║
  ║  Target:   ${TARGET_URL.padEnd(33)}║
  ║  Interval: ${String(INTERVAL_MS / 1000 + 's').padEnd(33)}║
  ╚══════════════════════════════════════════════╝
  `);

  // Wait for target to be ready
  let ready = false;
  for (let attempt = 1; attempt <= 30; attempt++) {
    ready = await checkTarget();
    if (ready) break;
    console.log(`[loadgen] Waiting for target (attempt ${attempt}/30)...`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (!ready) {
    console.error('[loadgen] Target never became ready. Exiting.');
    process.exit(1);
  }

  // Run initial cycle
  await runTrafficCycle();

  // Schedule recurring cycles
  const intervalSeconds = Math.max(10, Math.round(INTERVAL_MS / 1000));
  console.log(`[loadgen] Scheduling traffic every ${intervalSeconds}s`);

  setInterval(async () => {
    try {
      await runTrafficCycle();
    } catch (error) {
      console.error('[loadgen] Cycle error:', error.message);
    }
  }, INTERVAL_MS);

  // Every 10 minutes: slow burst (send 3 extra search requests rapidly)
  setInterval(async () => {
    console.log('[loadgen] === SLOW BURST (10-min interval) ===');
    await sendSearchRequests(3);
    await sendLoginRequests(2);
  }, 10 * 60 * 1000);
}

main().catch((error) => {
  console.error('[loadgen] Fatal error:', error);
  process.exit(1);
});
