const { COPYBOOKS } = require('./d21dc676-catalog');

/**
 * Schema-driven mock data. Devin has no SQL access in the Sysco environment,
 * so the parallel run feeds both the legacy job and the Java job the same
 * generated focus-file rows, built from the FOCLOT copybook Sysco shared.
 */

const OPCOS = ['001', '019', '056', '067', '164', '293'];
const BUSINESS_DATE = '20261027';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function digits(rand, n) {
  let out = '';
  for (let i = 0; i < n; i += 1) out += Math.floor(rand() * 10);
  return out;
}

function generateFocusLots({ rows = 1200, seed = 20261027 } = {}) {
  const rand = mulberry32(seed);
  const lots = [];
  for (let i = 0; i < rows; i += 1) {
    const priorClose = 1 + Math.floor(rand() * 480);
    const adj = Math.floor(rand() * 21) - 10;
    const costWhole = 6 + Math.floor(rand() * 180);
    const caseWt = (8 + rand() * 52).toFixed(2);
    lots.push({
      'FL-OPCO-NBR': OPCOS[i % OPCOS.length],
      'FL-ITEM-NBR': String(1000000 + Math.floor(rand() * 8999999)),
      'FL-LOT-NBR': `L${BUSINESS_DATE.slice(2)}${String(i + 1).padStart(3, '0')}`,
      'FL-RCV-DT': `202610${String(1 + Math.floor(rand() * 26)).padStart(2, '0')}`,
      'FL-PRIOR-CLOSE-QTY': String(priorClose),
      'FL-ADJ-QTY': String(Math.max(adj, -priorClose + 1)),
      'FL-AVG-UNIT-COST': `${costWhole}.${digits(rand, 4)}`,
      'FL-AVG-CASE-WT': caseWt,
      'FL-LOT-STATUS-CD': rand() < 0.9 ? 'O' : 'P',
    });
  }
  return lots;
}

function describe() {
  return {
    copybook: COPYBOOKS.FOCLOT.name,
    fields: COPYBOOKS.FOCLOT.fields.length,
    opcos: OPCOS.length,
    businessDate: BUSINESS_DATE,
  };
}

module.exports = { generateFocusLots, describe, BUSINESS_DATE };
