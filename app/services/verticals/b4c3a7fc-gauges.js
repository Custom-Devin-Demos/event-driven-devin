const TANK_GAUGES = {
  'TK-PAS-101': { openingBbl: 186420, closingBbl: 191860, apiGravity: 32.1, tempF: 78.4, readAt: '2026-09-13T05:42:16.000Z' },
  'TK-PAS-102': { openingBbl: 174980, closingBbl: 171240, apiGravity: 31.8, tempF: 79.1, readAt: '2026-09-13T05:43:02.000Z' },
  'TK-COL-201': { openingBbl: 248600, closingBbl: 246180, apiGravity: 33.4, tempF: 77.8, readAt: '2026-09-13T05:44:11.000Z' },
  'TK-RCH-310': { openingBbl: 132750, closingBbl: 140920, apiGravity: 38.6, tempF: 71.2, readAt: '2026-09-13T05:38:47.000Z' },
  'TK-RCH-311': { openingBbl: 118430, closingBbl: 113880, apiGravity: 41.2, tempF: 70.7, readAt: '2026-09-13T05:39:20.000Z' },
  'TK-BAY-402': { openingBbl: 207910, closingBbl: 199480, apiGravity: 39.5, tempF: 72.5, readAt: '2026-09-13T05:40:06.000Z' },
  'TK-MID-510': { openingBbl: 294180, closingBbl: 303760, apiGravity: 35.7, tempF: 84.3, readAt: '2026-09-13T05:31:15.000Z' },
  'TK-CRN-520': { openingBbl: 265740, closingBbl: 259320, apiGravity: 34.9, tempF: 83.8, readAt: '2026-09-13T05:32:04.000Z' },
  'TK-ELS-601': { openingBbl: 156820, closingBbl: 151470, apiGravity: 41.6, tempF: 68.9, readAt: '2026-09-13T05:35:29.000Z' },
  'TK-LAX-610': { openingBbl: 221460, closingBbl: 224920, apiGravity: 42.1, tempF: 69.4, readAt: '2026-09-13T05:36:12.000Z' },
};

async function readTankGauges(tankIds) {
  await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 25));
  return tankIds.reduce((gauges, tankId) => {
    if (TANK_GAUGES[tankId]) gauges[tankId] = TANK_GAUGES[tankId];
    return gauges;
  }, {});
}

module.exports = { readTankGauges, TANK_GAUGES };
