const TANK_GAUGES = {
  'TK-PAS-101': { startBbl: 186420, endBbl: 186445, levelFt: 41.2, apiGravity: 32.1, tempF: 78.4 },
  'TK-PAS-102': { startBbl: 174980, endBbl: 174980, levelFt: 38.7, apiGravity: 31.8, tempF: 79.1 },
  'TK-COL-201': { startBbl: 248600, endBbl: 248610, levelFt: 44.9, apiGravity: 33.4, tempF: 77.8 },
  'TK-RCH-310': { startBbl: 132750, endBbl: 132760, levelFt: 36.1, apiGravity: 38.6, tempF: 71.2 },
  'TK-RCH-311': { startBbl: 118430, endBbl: 118430, levelFt: 33.4, apiGravity: 41.2, tempF: 70.7 },
  'TK-BAY-402': { startBbl: 207910, endBbl: 207918, levelFt: 42.6, apiGravity: 39.5, tempF: 72.5 },
  'TK-MID-510': { startBbl: 294180, endBbl: 294200, levelFt: 46.3, apiGravity: 35.7, tempF: 84.3 },
  'TK-CRN-520': { startBbl: 265740, endBbl: 265752, levelFt: 45.1, apiGravity: 34.9, tempF: 83.8 },
  'TK-ELS-601': { startBbl: 156820, endBbl: 156826, levelFt: 39.8, apiGravity: 41.6, tempF: 68.9 },
  'TK-LAX-610': { startBbl: 221460, endBbl: 221464, levelFt: 43.2, apiGravity: 42.1, tempF: 69.4 },
  'TK-SLC-701': { startBbl: 88400, endBbl: 88410, levelFt: 29.6, apiGravity: 40.3, tempF: 66.8 },
  'TK-BOI-710': { startBbl: 96200, endBbl: 96206, levelFt: 30.9, apiGravity: 40.1, tempF: 65.2 },
};

async function readTankGauges(tankIds) {
  await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 25));
  return tankIds.reduce((gauges, tankId) => {
    if (TANK_GAUGES[tankId]) gauges[tankId] = TANK_GAUGES[tankId];
    return gauges;
  }, {});
}

module.exports = { readTankGauges, TANK_GAUGES };
