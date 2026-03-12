#!/usr/bin/env node

/**
 * Demo Trigger Script
 * Switches the app to an incident scenario.
 *
 * Usage:
 *   node scripts/trigger.js checkout-regression
 *   node scripts/trigger.js slow-db
 *   node scripts/trigger.js dependency-timeout
 *   node scripts/trigger.js healthy
 */

const axios = require('axios');

const TARGET = process.env.LOADGEN_TARGET_URL || 'http://localhost:3000';

async function trigger(scenario) {
  if (!scenario) {
    console.log('Usage: node scripts/trigger.js <scenario>');
    console.log('');
    console.log('Available scenarios:');
    console.log('  healthy              - All systems normal');
    console.log('  slow-db              - Slow database queries (1.5-3s latency)');
    console.log('  checkout-regression  - v1.0.1 null reference bug in calculateTax');
    console.log('  dependency-timeout   - Payment gateway timeouts (30% failure rate)');
    process.exit(1);
  }

  console.log(`[trigger] Switching to scenario: ${scenario}`);

  try {
    const res = await axios.post(`${TARGET}/admin/scenario`, { scenario });
    console.log('[trigger] Success:', res.data);
  } catch (error) {
    const msg = error.response ? error.response.data : error.message;
    console.error('[trigger] Failed:', msg);
    process.exit(1);
  }
}

const scenario = process.argv[2];
trigger(scenario);
