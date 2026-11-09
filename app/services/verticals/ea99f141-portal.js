const PLAN_ENTITLEMENTS = {
  'INT-100': { speedMbps: 100, selfInstall: true, advancedWifi: false, securityShield: true },
  'INT-500': { speedMbps: 500, selfInstall: true, advancedWifi: true, securityShield: true },
  'INT-1G': { speedMbps: 1000, selfInstall: false, advancedWifi: true, securityShield: true },
  'TV-SELECT': { channels: 125, cloudDvrHours: 100 },
  'MOB-UNL-PLUS': { hotspotGb: 50, lines: 1 },
};

const FOOTPRINT_PORTALS = {
  Carolinas: { region: 'SE', supportQueue: 'care-se', sessionTtlMinutes: 30 },
  Northeast: { region: 'NE', supportQueue: 'care-ne', sessionTtlMinutes: 30 },
};

function primaryLineFor(household) {
  return household.services[household.primaryLine];
}

function entitlementsFor(line) {
  return {
    planCode: line.planCode,
    ...(PLAN_ENTITLEMENTS[line.planCode] || {}),
    equipment: line.equipment,
  };
}

function portalFor(household) {
  return FOOTPRINT_PORTALS[household.footprint] || FOOTPRINT_PORTALS.Carolinas;
}

module.exports = {
  primaryLineFor, entitlementsFor, portalFor, PLAN_ENTITLEMENTS,
};
