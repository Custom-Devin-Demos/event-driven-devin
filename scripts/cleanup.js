#!/usr/bin/env node

/**
 * Demo Cleanup Script
 * Resets the app to healthy state after a demo.
 */

const axios = require('axios');

const TARGET = process.env.LOADGEN_TARGET_URL || 'http://localhost:3000';

async function cleanup() {
  console.log('[cleanup] Resetting to healthy state...');

  try {
    const res = await axios.post(`${TARGET}/admin/scenario`, { scenario: 'healthy' });
    console.log('[cleanup] Scenario reset:', res.data);
  } catch (error) {
    console.error('[cleanup] Failed to reset scenario:', error.message);
  }

  // Verify
  try {
    const health = await axios.get(`${TARGET}/health`);
    console.log('[cleanup] Health check:', health.data);
    console.log('\n[cleanup] System is clean and ready.');
  } catch (error) {
    console.error('[cleanup] Health check failed:', error.message);
  }
}

cleanup();
