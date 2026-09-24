/**
 * Network master data for the stock & inventory control tower: distribution
 * centres, stores, service tiers and the SKU catalogue. Positions are derived
 * deterministically from the site and SKU identifiers so the demo renders the
 * same numbers on every run.
 */

const SERVICE_TIERS = {
  'tier-1': { label: 'Tier 1 — flagship', safetyStockDays: 9, fillRateTarget: 0.985, reviewCycleDays: 1 },
  'tier-2': { label: 'Tier 2 — high street', safetyStockDays: 6, fillRateTarget: 0.97, reviewCycleDays: 2 },
  'tier-3': { label: 'Tier 3 — regional', safetyStockDays: 4, fillRateTarget: 0.95, reviewCycleDays: 3 },
};

const SITES = [
  {
    id: 'NDC-CDON',
    name: 'Castle Donington NDC',
    kind: 'National DC',
    city: 'Castle Donington',
    region: 'East Midlands',
    lat: 52.8306,
    lng: -1.3181,
    serviceTier: 'TIER_1',
    leadTimeDays: 2,
    capacityUnits: 480000,
    openReplenLines: 184,
  },
  {
    id: 'RDC-BRAD',
    name: 'Bradford RDC',
    kind: 'Regional DC',
    city: 'Bradford',
    region: 'Yorkshire',
    lat: 53.796,
    lng: -1.7594,
    serviceTier: 'TIER_2',
    leadTimeDays: 3,
    capacityUnits: 260000,
    openReplenLines: 121,
  },
  {
    id: 'RDC-SWIN',
    name: 'Swindon RDC',
    kind: 'Regional DC',
    city: 'Swindon',
    region: 'South West',
    lat: 51.5686,
    lng: -1.7722,
    serviceTier: 'TIER_2',
    leadTimeDays: 3,
    capacityUnits: 245000,
    openReplenLines: 96,
  },
  {
    id: 'STR-MARB',
    name: 'Marble Arch',
    kind: 'Flagship store',
    city: 'London',
    region: 'Greater London',
    lat: 51.5136,
    lng: -0.1586,
    serviceTier: 'TIER_1',
    leadTimeDays: 1,
    capacityUnits: 42000,
    openReplenLines: 63,
  },
  {
    id: 'STR-TRAF',
    name: 'Trafford Centre',
    kind: 'Large store',
    city: 'Manchester',
    region: 'North West',
    lat: 53.4668,
    lng: -2.3487,
    serviceTier: 'TIER_2',
    leadTimeDays: 2,
    capacityUnits: 31000,
    openReplenLines: 48,
  },
  {
    id: 'STR-EDIN',
    name: 'Princes Street',
    kind: 'Large store',
    city: 'Edinburgh',
    region: 'Scotland',
    lat: 55.952,
    lng: -3.1965,
    serviceTier: 'TIER_3',
    leadTimeDays: 4,
    capacityUnits: 26500,
    openReplenLines: 37,
  },
  {
    id: 'STR-BIRM',
    name: 'Bullring',
    kind: 'Large store',
    city: 'Birmingham',
    region: 'West Midlands',
    lat: 52.4778,
    lng: -1.8935,
    serviceTier: 'TIER_2',
    leadTimeDays: 2,
    capacityUnits: 28800,
    openReplenLines: 44,
  },
  {
    id: 'STR-LEED',
    name: 'White Rose',
    kind: 'Large store',
    city: 'Leeds',
    region: 'Yorkshire',
    lat: 53.7529,
    lng: -1.5729,
    serviceTier: 'TIER_2',
    leadTimeDays: 2,
    capacityUnits: 24100,
    openReplenLines: 39,
  },
  {
    id: 'STR-CARD',
    name: 'Queen Street',
    kind: 'Standard store',
    city: 'Cardiff',
    region: 'Wales',
    lat: 51.4816,
    lng: -3.1748,
    serviceTier: 'TIER_3',
    leadTimeDays: 4,
    capacityUnits: 18400,
    openReplenLines: 28,
  },
];

const SKUS = [
  { id: 'SKU-41882', name: 'Cotton Rich Chino Trousers', department: 'Menswear', unitCostPence: 1450, retailPricePence: 3500, caseSize: 12, baseDemand: 310 },
  { id: 'SKU-52107', name: 'Pure Cashmere Roll Neck', department: 'Womenswear', unitCostPence: 3900, retailPricePence: 8900, caseSize: 6, baseDemand: 145 },
  { id: 'SKU-60344', name: 'Percy Pig Sharing Bag 170g', department: 'Food', unitCostPence: 62, retailPricePence: 150, caseSize: 24, baseDemand: 2400 },
  { id: 'SKU-60912', name: 'Collection Bath Towel — Slate', department: 'Home', unitCostPence: 540, retailPricePence: 1400, caseSize: 10, baseDemand: 420 },
  { id: 'SKU-71255', name: 'Autograph Leather Chelsea Boot', department: 'Footwear', unitCostPence: 4200, retailPricePence: 9900, caseSize: 8, baseDemand: 118 },
  { id: 'SKU-73401', name: 'Dine In Chicken Kyiv 2pk', department: 'Food', unitCostPence: 210, retailPricePence: 500, caseSize: 18, baseDemand: 1650 },
  { id: 'SKU-80620', name: 'Sparkling Elderflower 750ml', department: 'Food', unitCostPence: 95, retailPricePence: 260, caseSize: 12, baseDemand: 1980 },
  { id: 'SKU-91188', name: 'Sleepwear Fleece Set', department: 'Kidswear', unitCostPence: 780, retailPricePence: 1800, caseSize: 10, baseDemand: 365 },
];

/** Stable integer derived from a string, used to vary the seeded positions. */
function fingerprint(value) {
  let hash = 7;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100003;
  }
  return hash;
}

function siteWeight(site) {
  return site.kind.includes('DC') ? 6.5 : 1;
}

function buildPositions() {
  const positions = [];
  for (const site of SITES) {
    for (const sku of SKUS) {
      const spread = fingerprint(`${site.id}:${sku.id}`);
      const weeklyDemand = Math.round((sku.baseDemand * siteWeight(site)) / 9 + (spread % 37));
      const onHand = Math.round(weeklyDemand * (1.1 + (spread % 60) / 100));
      const allocated = Math.round(weeklyDemand * ((spread % 25) / 100));
      const inTransit = spread % 7 === 0 ? Math.round(weeklyDemand * 0.6) : 0;
      positions.push({
        siteId: site.id,
        sku: sku.id,
        onHand,
        allocated,
        inTransit,
        weeklyDemand,
      });
    }
  }
  return positions;
}

const POSITIONS = buildPositions();

function positionsForSite(siteId) {
  return POSITIONS.filter((position) => position.siteId === siteId);
}

function positionsForSku(skuId) {
  return POSITIONS.filter((position) => position.sku === skuId);
}

function getSite(siteId) {
  return SITES.find((site) => site.id === siteId);
}

function getSku(skuId) {
  return SKUS.find((sku) => sku.id === skuId);
}

module.exports = {
  SERVICE_TIERS,
  SITES,
  SKUS,
  POSITIONS,
  fingerprint,
  positionsForSite,
  positionsForSku,
  getSite,
  getSku,
};
