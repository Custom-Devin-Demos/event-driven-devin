const PLAYERS = [
  {
    nucleusId: '1004418823',
    personaId: '2290417561',
    displayName: 'Rook_Kestrel',
    locale: 'en_US',
    platform: 'pc',
    entitlements: { subscription: 'EA_PLAY_PRO', owned: ['FC27_ULTIMATE', 'BF6_STANDARD', 'TS4_BASE'] },
  },
  {
    nucleusId: '1007730195',
    personaId: '2311840092',
    displayName: 'MarrowLark',
    locale: 'en_GB',
    platform: 'ps5',
    entitlements: { subscription: 'EA_PLAY', owned: ['MADDEN27_DELUXE', 'APEX_FREE'] },
  },
  {
    nucleusId: '1009925741',
    personaId: '2374458810',
    displayName: 'quietfuse',
    locale: 'fr_FR',
    platform: 'xbsx',
    entitlements: { subscription: 'NONE', owned: ['APEX_FREE'] },
  },
];

async function lookupPlayer({ deviceId, locale }) {
  await Promise.resolve();
  const player = PLAYERS.find((p) => p.locale === locale) || PLAYERS[0];
  return {
    ...player,
    deviceId: deviceId || null,
    entitlements: { ...player.entitlements, owned: [...player.entitlements.owned] },
  };
}

module.exports = { lookupPlayer, PLAYERS };
