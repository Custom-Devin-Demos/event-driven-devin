const ASSET_RECORDS_SCHEMA = {
  product: 'Asset Records',
  version: '4.3.0',
  previousVersion: '4.2.1',
  publishedAt: '2026-10-17T14:22:00Z',
  author: 'r.okafor',
  team: 'Asset Data Platform',
  changeId: 'ADP-2291',
  changeSummary: 'engine.lastShopVisit is now nullable. Engines with no completed shop visit no longer carry a synthetic delivery-event record; consumers read deliveredAt directly.',
  fields: [
    { name: 'esn', type: 'string', nullable: false },
    { name: 'tail', type: 'string', nullable: false },
    { name: 'position', type: 'integer', nullable: false },
    { name: 'model', type: 'string', nullable: false },
    { name: 'tsn', type: 'integer', nullable: false },
    { name: 'csn', type: 'integer', nullable: false },
    { name: 'deliveredAt', type: 'date', nullable: false },
    { name: 'lastShopVisit', type: 'object', nullable: true, changedIn: '4.3.0' },
    { name: 'egtMarginC', type: 'number', nullable: false },
    { name: 'derate', type: 'number', nullable: false },
  ],
};

const SHOP_VISIT_INTERVALS = {
  'LEAP-1B': { softLimitCycles: 20000, hardLimitCycles: 24000 },
  'NX-1B': { softLimitCycles: 9000, hardLimitCycles: 11000 },
  'RJ-8E': { softLimitCycles: 15000, hardLimitCycles: 18000 },
  'NX-115B': { softLimitCycles: 7000, hardLimitCycles: 8500 },
};

const ENGINE_RECORDS = {
  'AIR-A': [
    { esn: '598-14027', tail: 'N721AA', position: 1, model: 'LEAP-1B', tsn: 18942, csn: 11380, deliveredAt: '2019-04-12', lastShopVisit: { date: '2024-11-03', shop: 'Celma', workscope: 'Performance restoration', csnAtVisit: 8210 }, egtMarginC: 34.2, derate: 0.10 },
    { esn: '598-14028', tail: 'N721AA', position: 2, model: 'LEAP-1B', tsn: 18877, csn: 11351, deliveredAt: '2019-04-12', lastShopVisit: { date: '2024-11-03', shop: 'Celma', workscope: 'Performance restoration', csnAtVisit: 8188 }, egtMarginC: 31.8, derate: 0.10 },
    { esn: '598-16115', tail: 'N733AA', position: 1, model: 'LEAP-1B', tsn: 12410, csn: 7466, deliveredAt: '2021-02-18', lastShopVisit: { date: '2025-06-21', shop: 'Wales', workscope: 'Hospital visit — HPT blade', csnAtVisit: 6904 }, egtMarginC: 41.5, derate: 0.08 },
    { esn: '598-16116', tail: 'N733AA', position: 2, model: 'LEAP-1B', tsn: 12402, csn: 7461, deliveredAt: '2021-02-18', lastShopVisit: { date: '2023-09-14', shop: 'Wales', workscope: 'Quick-turn — combustor', csnAtVisit: 4120 }, egtMarginC: 29.1, derate: 0.08 },
    { esn: '956-00412', tail: 'N809AA', position: 1, model: 'NX-1B', tsn: 31220, csn: 4815, deliveredAt: '2016-08-30', lastShopVisit: { date: '2024-02-09', shop: 'Cincinnati', workscope: 'Full overhaul', csnAtVisit: 3390 }, egtMarginC: 22.4, derate: 0.05 },
    { esn: '956-00413', tail: 'N809AA', position: 2, model: 'NX-1B', tsn: 31198, csn: 4809, deliveredAt: '2016-08-30', lastShopVisit: { date: '2024-02-09', shop: 'Cincinnati', workscope: 'Full overhaul', csnAtVisit: 3384 }, egtMarginC: 24.0, derate: 0.05 },
  ],
  'AIR-B': [
    { esn: '598-21874', tail: 'G-BXCA', position: 1, model: 'LEAP-1B', tsn: 9880, csn: 6102, deliveredAt: '2022-05-07', lastShopVisit: { date: '2025-03-30', shop: 'Wales', workscope: 'Hospital visit — fuel nozzle', csnAtVisit: 5240 }, egtMarginC: 37.6, derate: 0.10 },
    { esn: '598-21875', tail: 'G-BXCA', position: 2, model: 'LEAP-1B', tsn: 9871, csn: 6098, deliveredAt: '2022-05-07', lastShopVisit: { date: '2025-03-30', shop: 'Wales', workscope: 'Hospital visit — fuel nozzle', csnAtVisit: 5236 }, egtMarginC: 36.9, derate: 0.10 },
    { esn: '598-23301', tail: 'G-BXCD', position: 1, model: 'LEAP-1B', tsn: 4120, csn: 2566, deliveredAt: '2024-01-22', lastShopVisit: { date: '2025-09-11', shop: 'Celma', workscope: 'Quick-turn — borescope finding', csnAtVisit: 2410 }, egtMarginC: 44.3, derate: 0.08 },
    { esn: '598-23302', tail: 'G-BXCD', position: 2, model: 'LEAP-1B', tsn: 4116, csn: 2564, deliveredAt: '2024-01-22', lastShopVisit: { date: '2025-09-11', shop: 'Celma', workscope: 'Quick-turn — borescope finding', csnAtVisit: 2408 }, egtMarginC: 45.0, derate: 0.08 },
    { esn: '598-24930', tail: 'G-BXCF', position: 1, model: 'LEAP-1B', tsn: 212, csn: 141, deliveredAt: '2026-09-29', lastShopVisit: null, egtMarginC: 52.8, derate: 0.10 },
    { esn: '598-24931', tail: 'G-BXCF', position: 2, model: 'LEAP-1B', tsn: 212, csn: 141, deliveredAt: '2026-09-29', lastShopVisit: null, egtMarginC: 53.1, derate: 0.10 },
    { esn: '902-30077', tail: 'G-BXGA', position: 1, model: 'NX-115B', tsn: 44810, csn: 5912, deliveredAt: '2014-11-05', lastShopVisit: { date: '2023-07-19', shop: 'Cardiff', workscope: 'Full overhaul', csnAtVisit: 4320 }, egtMarginC: 18.7, derate: 0.00 },
    { esn: '902-30078', tail: 'G-BXGA', position: 2, model: 'NX-115B', tsn: 44790, csn: 5908, deliveredAt: '2014-11-05', lastShopVisit: { date: '2023-07-19', shop: 'Cardiff', workscope: 'Full overhaul', csnAtVisit: 4316 }, egtMarginC: 19.9, derate: 0.00 },
  ],
  'LES-C': [
    { esn: '598-19202', tail: 'EI-LCA', position: 1, model: 'LEAP-1B', tsn: 14380, csn: 8921, deliveredAt: '2020-06-15', lastShopVisit: { date: '2025-01-27', shop: 'Celma', workscope: 'Performance restoration', csnAtVisit: 7410 }, egtMarginC: 33.0, derate: 0.10 },
    { esn: '598-19203', tail: 'EI-LCA', position: 2, model: 'LEAP-1B', tsn: 14371, csn: 8917, deliveredAt: '2020-06-15', lastShopVisit: { date: '2025-01-27', shop: 'Celma', workscope: 'Performance restoration', csnAtVisit: 7404 }, egtMarginC: 32.2, derate: 0.10 },
    { esn: '765-08841', tail: 'EI-LCR', position: 1, model: 'RJ-8E', tsn: 27650, csn: 19870, deliveredAt: '2012-03-02', lastShopVisit: { date: '2024-05-16', shop: 'Strother', workscope: 'Full overhaul', csnAtVisit: 15200 }, egtMarginC: 20.6, derate: 0.05 },
    { esn: '765-08842', tail: 'EI-LCR', position: 2, model: 'RJ-8E', tsn: 27633, csn: 19861, deliveredAt: '2012-03-02', lastShopVisit: { date: '2024-05-16', shop: 'Strother', workscope: 'Full overhaul', csnAtVisit: 15190 }, egtMarginC: 21.3, derate: 0.05 },
    { esn: '956-01190', tail: 'EI-LCX', position: 1, model: 'NX-1B', tsn: 19040, csn: 2980, deliveredAt: '2019-10-21', lastShopVisit: { date: '2025-08-02', shop: 'Cincinnati', workscope: 'Hospital visit — VSV actuator', csnAtVisit: 2710 }, egtMarginC: 27.5, derate: 0.05 },
    { esn: '956-01191', tail: 'EI-LCX', position: 2, model: 'NX-1B', tsn: 19022, csn: 2975, deliveredAt: '2019-10-21', lastShopVisit: { date: '2025-08-02', shop: 'Cincinnati', workscope: 'Hospital visit — VSV actuator', csnAtVisit: 2706 }, egtMarginC: 28.1, derate: 0.05 },
  ],
};

async function readAssetRecords(customerId) {
  await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 20));
  const records = ENGINE_RECORDS[customerId];
  if (!records) {
    throw new Error(`Asset Records has no fleet for customer ${customerId}`);
  }
  return records.map((record) => ({ ...record, schemaVersion: ASSET_RECORDS_SCHEMA.version }));
}

function shopVisitInterval(model) {
  return SHOP_VISIT_INTERVALS[model] || { softLimitCycles: 10000, hardLimitCycles: 12000 };
}

module.exports = { readAssetRecords, shopVisitInterval, ASSET_RECORDS_SCHEMA, ENGINE_RECORDS, SHOP_VISIT_INTERVALS };
