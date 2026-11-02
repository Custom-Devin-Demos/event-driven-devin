#!/usr/bin/env node
/* global fetch */
/**
 * TogetherMoney website — eligibility traffic generator for the Demo 3 on-call
 * skin (77c11f38). Sends a mix of good enquiries and a few self-employed
 * enquiries with formatted income ("£45,000") that hit the planted 500.
 *
 * Usage: node scripts/77c11f38-traffic.js [baseUrl] [--alert]
 *   baseUrl defaults to http://localhost:3100.
 *   --alert also posts ONE on-call alert card (skin 77c11f38, server-routed
 *   to Teams oncall-demo) after the first failure.
 */
const BASE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://localhost:3100').replace(/\/$/, '');
const ALERT = process.argv.includes('--alert');
const ROUTE = '/api/oncall/eligibility/check';

const ENQUIRIES = [
  { loanAmount: '40000', propertyValue: '325000', employmentType: 'employed', annualIncome: '45000', postcode: 'M3 3HF' },
  { loanAmount: '£25,000', propertyValue: '£280,000', employmentType: 'employed', annualIncome: '£45,000', postcode: 'LS1 4DY' },
  { loanAmount: '60000', propertyValue: '410000', employmentType: 'self-employed', annualIncome: '72000', postcode: 'BS1 5TR' },
  { loanAmount: '35000', propertyValue: '300000', employmentType: 'self-employed', annualIncome: '£45,000', postcode: 'NE1 7RU' },
  { loanAmount: '18000', propertyValue: '240000', employmentType: 'retired', annualIncome: '£28,500', postcode: 'CF10 1EP' },
  { loanAmount: '50000', propertyValue: '390000', employmentType: 'self-employed', annualIncome: '58,250', postcode: 'B3 2BJ' },
  { loanAmount: '30000', propertyValue: '260000', employmentType: 'employed', annualIncome: '39,000', postcode: 'G2 1DY' },
  { loanAmount: '45000', propertyValue: '350000', employmentType: 'self-employed', annualIncome: '£61,000', postcode: 'EH2 2BY' },
];

async function main() {
  let ok = 0;
  let failed = 0;
  let alerted = false;
  for (const enquiry of ENQUIRIES) {
    const res = await fetch(`${BASE}${ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...enquiry, consent: true }),
    });
    const data = await res.json().catch(() => ({}));
    const label = `${enquiry.employmentType.padEnd(13)} income=${enquiry.annualIncome.padEnd(8)}`;
    if (res.status === 200) {
      ok += 1;
      console.log(`200 ${label} → ${data.decision} ${data.enquiryId}`);
    } else {
      failed += 1;
      console.log(`${res.status} ${label} → ${data.errorClass || ''} ${data.code || ''}`);
      if (ALERT && res.status >= 500 && !alerted) {
        alerted = true;
        const alert = await fetch(`${BASE}/api/oncall/trigger/eligibility`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skin: '77c11f38', unique: true }),
        });
        console.log(`    on-call alert → HTTP ${alert.status}`);
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`\n${ok} succeeded, ${failed} failed (${ENQUIRIES.length} enquiries)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
