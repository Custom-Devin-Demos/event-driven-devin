const { lookupPlayer } = require('./99fb2e83-identity');

const PLAN_ACCESS = {
  EA_PLAY_PRO: { vault: 'pro', earlyAccess: true, memberDiscountPct: 10 },
  EA_PLAY: { vault: 'standard', earlyAccess: true, memberDiscountPct: 10 },
  NONE: { vault: null, earlyAccess: false, memberDiscountPct: 0 },
};

const TITLES = {
  FC27_ULTIMATE: 'EA SPORTS FC™ 27 Ultimate Edition',
  BF6_STANDARD: 'Battlefield™ 6',
  TS4_BASE: 'The Sims™ 4',
  MADDEN27_DELUXE: 'EA SPORTS™ Madden NFL 27 Deluxe Edition',
  APEX_FREE: 'Apex Legends™',
};

function launchContextFor(handoff) {
  const player = lookupPlayer({ deviceId: handoff.deviceId, locale: handoff.locale });
  return {
    player,
    locale: handoff.locale || 'en_US',
    surface: handoff.entryPoint,
  };
}

function accessFor(context) {
  const plan = PLAN_ACCESS[context.player.entitlements.subscription] || PLAN_ACCESS.NONE;
  return { ...plan, subscription: context.player.entitlements.subscription };
}

function libraryFor(context) {
  return context.player.entitlements.owned.map((code) => ({ code, title: TITLES[code] || code }));
}

module.exports = { launchContextFor, accessFor, libraryFor };
