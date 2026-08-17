const express = require('express');
const crypto = require('crypto');
const { setImmediate } = require('timers');
const logger = require('../telemetry/logger');

const router = express.Router();

const INVENTORY_SKU_COUNT = 120;
const ORDER_QUERY_COUNT = 40;
const RECONCILIATION_QUERY_COUNT = 6;
const SCAN_CHUNK_SIZE = 1024;
const RATE_WINDOW_MS = 60 * 1000;
const PER_IP_RATE_LIMIT = 10;
const PROCESS_RATE_LIMIT = 30;

let activeJob = false;
const ipRequestWindows = new Map();
const processRequestWindow = [];
let stockLedger;
let lineItems;
let ledger;

function getStockLedger() {
  if (!stockLedger) {
    stockLedger = Array.from({ length: 3200 }, (_, index) => ({
      sku: `SKU-${String(index % INVENTORY_SKU_COUNT).padStart(3, '0')}`,
      available: (index * 17) % 23,
    }));
  }
  return stockLedger;
}

function getLineItems() {
  if (!lineItems) {
    lineItems = Array.from({ length: 13000 }, (_, index) => ({
      orderId: `ORD-${String(index % ORDER_QUERY_COUNT).padStart(3, '0')}`,
      quantity: (index % 5) + 1,
      unitPrice: (index % 97) + 3,
    }));
  }
  return lineItems;
}

function getLedger() {
  if (!ledger) {
    ledger = Array.from({ length: 290000 }, (_, index) => ({
      accountId: `ACCT-${String(index % 1000).padStart(4, '0')}`,
      debit: (index * 13) % 101,
      credit: (index * 7) % 89,
    }));
  }
  return ledger;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest()[0];
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function pruneWindow(window, cutoff) {
  while (window.length && window[0] <= cutoff) window.shift();
}

function pruneIpWindows(cutoff) {
  for (const [ip, window] of ipRequestWindows) {
    pruneWindow(window, cutoff);
    if (!window.length) ipRequestWindows.delete(ip);
  }
}

function rejectRequest(res, message, retryAfterSeconds = 1) {
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({ success: false, error: message });
}

function internalJobGuard(req, res, next) {
  if (activeJob) {
    return rejectRequest(res, 'An internal job is already running. Try again shortly.');
  }

  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  pruneWindow(processRequestWindow, cutoff);
  pruneIpWindows(cutoff);

  const ip = clientIp(req);
  const ipWindow = ipRequestWindows.get(ip) || [];
  if (ipWindow.length >= PER_IP_RATE_LIMIT) {
    const retryAfterSeconds = Math.ceil((ipWindow[0] + RATE_WINDOW_MS - now) / 1000);
    return rejectRequest(res, 'Internal job rate limit reached for this IP.', Math.max(retryAfterSeconds, 1));
  }
  if (processRequestWindow.length >= PROCESS_RATE_LIMIT) {
    const retryAfterSeconds = Math.ceil((processRequestWindow[0] + RATE_WINDOW_MS - now) / 1000);
    return rejectRequest(res, 'Internal job process rate limit reached.', Math.max(retryAfterSeconds, 1));
  }

  ipWindow.push(now);
  ipRequestWindows.set(ip, ipWindow);
  processRequestWindow.push(now);
  activeJob = true;
  req.releaseInternalJob = () => {
    activeJob = false;
  };
  return next();
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function inventoryReport() {
  const startedAt = process.hrtime.bigint();
  const stockRows = getStockLedger();
  let totalAvailable = 0;

  for (let skuIndex = 0; skuIndex < INVENTORY_SKU_COUNT; skuIndex++) {
    const queryStartedAt = process.hrtime.bigint();
    const sku = `SKU-${String(skuIndex).padStart(3, '0')}`;
    let available = 0;

    for (let rowIndex = 0; rowIndex < stockRows.length; rowIndex++) {
      const row = stockRows[rowIndex];
      available += fingerprint(`${row.sku}:${row.available}`) & 1;
      if (row.sku === sku) {
        available += row.available;
      }
      if ((rowIndex + 1) % SCAN_CHUNK_SIZE === 0) await yieldToEventLoop();
    }

    totalAvailable += available;
    const durationMs = Number(process.hrtime.bigint() - queryStartedAt) / 1e6;
    logger.info('db.query', {
      event: 'db.query',
      query_name: 'inventory.stock_by_sku',
      duration_ms: Number(durationMs.toFixed(3)),
      rows_scanned: stockRows.length,
      job: 'inventory_report',
      endpoint: '/internal-jobs/inventory-report',
    });
  }

  const totalDurationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  logger.info('Internal job completed', {
    event: 'internal_job.summary',
    job: 'inventory_report',
    endpoint: '/internal-jobs/inventory-report',
    total_duration_ms: Number(totalDurationMs.toFixed(3)),
    inner_query_count: INVENTORY_SKU_COUNT,
  });

  return { totalAvailable, innerQueryCount: INVENTORY_SKU_COUNT, totalDurationMs };
}

async function orderExport() {
  const startedAt = process.hrtime.bigint();
  const lineItemRows = getLineItems();
  let exportedRows = 0;

  for (let orderIndex = 0; orderIndex < ORDER_QUERY_COUNT; orderIndex++) {
    const queryStartedAt = process.hrtime.bigint();
    const orderId = `ORD-${String(orderIndex).padStart(3, '0')}`;
    let itemCount = 0;

    for (let rowIndex = 0; rowIndex < lineItemRows.length; rowIndex++) {
      const lineItem = lineItemRows[rowIndex];
      itemCount += fingerprint(`${lineItem.orderId}:${lineItem.quantity}:${lineItem.unitPrice}`) & 1;
      if (lineItem.orderId === orderId) {
        itemCount += lineItem.quantity;
      }
      if ((rowIndex + 1) % SCAN_CHUNK_SIZE === 0) await yieldToEventLoop();
    }

    exportedRows += itemCount;
    const durationMs = Number(process.hrtime.bigint() - queryStartedAt) / 1e6;
    logger.info('db.query', {
      event: 'db.query',
      query_name: 'orders.line_items_scan',
      duration_ms: Number(durationMs.toFixed(3)),
      rows_scanned: lineItemRows.length,
      job: 'order_export',
      endpoint: '/internal-jobs/order-export',
    });
  }

  const totalDurationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  logger.info('Internal job completed', {
    event: 'internal_job.summary',
    job: 'order_export',
    endpoint: '/internal-jobs/order-export',
    total_duration_ms: Number(totalDurationMs.toFixed(3)),
    inner_query_count: ORDER_QUERY_COUNT,
  });

  return { exportedRows, innerQueryCount: ORDER_QUERY_COUNT, totalDurationMs };
}

async function reconciliation() {
  const startedAt = process.hrtime.bigint();
  const ledgerRows = getLedger();
  let discrepancyCount = 0;

  for (let entryIndex = 0; entryIndex < RECONCILIATION_QUERY_COUNT; entryIndex++) {
    const queryStartedAt = process.hrtime.bigint();
    let balance = 0;

    for (let rowIndex = 0; rowIndex < ledgerRows.length; rowIndex++) {
      const entry = ledgerRows[rowIndex];
      balance += fingerprint(`${entry.accountId}:${entry.debit}:${entry.credit}`) & 1;
      balance += entry.debit - entry.credit;
      if ((rowIndex + 1) % SCAN_CHUNK_SIZE === 0) await yieldToEventLoop();
    }

    discrepancyCount += Math.abs(balance) % 2;
    const durationMs = Number(process.hrtime.bigint() - queryStartedAt) / 1e6;
    logger.info('db.query', {
      event: 'db.query',
      query_name: 'ledger.full_scan',
      duration_ms: Number(durationMs.toFixed(3)),
      rows_scanned: ledgerRows.length,
      job: 'reconciliation',
      endpoint: '/internal-jobs/reconciliation',
    });
  }

  const totalDurationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  logger.info('Internal job completed', {
    event: 'internal_job.summary',
    job: 'reconciliation',
    endpoint: '/internal-jobs/reconciliation',
    total_duration_ms: Number(totalDurationMs.toFixed(3)),
    inner_query_count: RECONCILIATION_QUERY_COUNT,
  });

  return { discrepancyCount, innerQueryCount: RECONCILIATION_QUERY_COUNT, totalDurationMs };
}

router.get('/internal-jobs/inventory-report', internalJobGuard, async (req, res) => {
  try {
    res.json({ success: true, job: 'inventory_report', ...(await inventoryReport()) });
  } finally {
    req.releaseInternalJob();
  }
});

router.get('/internal-jobs/order-export', internalJobGuard, async (req, res) => {
  try {
    res.json({ success: true, job: 'order_export', ...(await orderExport()) });
  } finally {
    req.releaseInternalJob();
  }
});

router.get('/internal-jobs/reconciliation', internalJobGuard, async (req, res) => {
  try {
    res.json({ success: true, job: 'reconciliation', ...(await reconciliation()) });
  } finally {
    req.releaseInternalJob();
  }
});

module.exports = router;
module.exports.inventoryReport = inventoryReport;
module.exports.orderExport = orderExport;
module.exports.reconciliation = reconciliation;
module.exports.constants = {
  INVENTORY_SKU_COUNT,
  ORDER_QUERY_COUNT,
  RECONCILIATION_QUERY_COUNT,
};
