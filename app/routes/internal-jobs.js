const express = require('express');
const crypto = require('crypto');
const logger = require('../telemetry/logger');

const router = express.Router();

const INVENTORY_SKU_COUNT = 120;
const ORDER_QUERY_COUNT = 40;
const RECONCILIATION_QUERY_COUNT = 6;

const stockLedger = Array.from({ length: 3200 }, (_, index) => ({
  sku: `SKU-${String(index % INVENTORY_SKU_COUNT).padStart(3, '0')}`,
  available: (index * 17) % 23,
}));

const lineItems = Array.from({ length: 13000 }, (_, index) => ({
  orderId: `ORD-${String(index % ORDER_QUERY_COUNT).padStart(3, '0')}`,
  quantity: (index % 5) + 1,
  unitPrice: (index % 97) + 3,
}));

const ledger = Array.from({ length: 290000 }, (_, index) => ({
  accountId: `ACCT-${String(index % 1000).padStart(4, '0')}`,
  debit: (index * 13) % 101,
  credit: (index * 7) % 89,
}));

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest()[0];
}

function inventoryReport() {
  const startedAt = process.hrtime.bigint();
  let totalAvailable = 0;

  for (let skuIndex = 0; skuIndex < INVENTORY_SKU_COUNT; skuIndex++) {
    const queryStartedAt = process.hrtime.bigint();
    const sku = `SKU-${String(skuIndex).padStart(3, '0')}`;
    let available = 0;

    stockLedger.forEach((row) => {
      available += fingerprint(`${row.sku}:${row.available}`) & 1;
      if (row.sku === sku) {
        available += row.available;
      }
    });

    totalAvailable += available;
    const durationMs = Number(process.hrtime.bigint() - queryStartedAt) / 1e6;
    logger.info('db.query', {
      event: 'db.query',
      query_name: 'inventory.stock_by_sku',
      duration_ms: Number(durationMs.toFixed(3)),
      rows_scanned: stockLedger.length,
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

function orderExport() {
  const startedAt = process.hrtime.bigint();
  let exportedRows = 0;

  for (let orderIndex = 0; orderIndex < ORDER_QUERY_COUNT; orderIndex++) {
    const queryStartedAt = process.hrtime.bigint();
    const orderId = `ORD-${String(orderIndex).padStart(3, '0')}`;
    let itemCount = 0;

    lineItems.forEach((lineItem) => {
      itemCount += fingerprint(`${lineItem.orderId}:${lineItem.quantity}:${lineItem.unitPrice}`) & 1;
      if (lineItem.orderId === orderId) {
        itemCount += lineItem.quantity;
      }
    });

    exportedRows += itemCount;
    const durationMs = Number(process.hrtime.bigint() - queryStartedAt) / 1e6;
    logger.info('db.query', {
      event: 'db.query',
      query_name: 'orders.line_items_scan',
      duration_ms: Number(durationMs.toFixed(3)),
      rows_scanned: lineItems.length,
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

function reconciliation() {
  const startedAt = process.hrtime.bigint();
  let discrepancyCount = 0;

  for (let entryIndex = 0; entryIndex < RECONCILIATION_QUERY_COUNT; entryIndex++) {
    const queryStartedAt = process.hrtime.bigint();
    let balance = 0;

    ledger.forEach((entry) => {
      balance += fingerprint(`${entry.accountId}:${entry.debit}:${entry.credit}`) & 1;
      balance += entry.debit - entry.credit;
    });

    discrepancyCount += Math.abs(balance) % 2;
    const durationMs = Number(process.hrtime.bigint() - queryStartedAt) / 1e6;
    logger.info('db.query', {
      event: 'db.query',
      query_name: 'ledger.full_scan',
      duration_ms: Number(durationMs.toFixed(3)),
      rows_scanned: ledger.length,
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

router.get('/internal-jobs/inventory-report', (_req, res) => {
  res.json({ success: true, job: 'inventory_report', ...inventoryReport() });
});

router.get('/internal-jobs/order-export', (_req, res) => {
  res.json({ success: true, job: 'order_export', ...orderExport() });
});

router.get('/internal-jobs/reconciliation', (_req, res) => {
  res.json({ success: true, job: 'reconciliation', ...reconciliation() });
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
