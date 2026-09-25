// Telematics gateway (TCU) manifests for the Talon Connect J1939 ingest.
// Each manifest describes one TCU hardware/firmware family: how its payloads
// are framed, which PGNs it broadcasts, and which SAE J1939-73 DM1 "SPN
// conversion method" its DTC bytes use.

const PGN_DECODE = {
  61444: { name: 'EEC1 — Electronic Engine Controller 1', spns: { 190: 'Engine Speed', 92: 'Engine Percent Load At Current Speed' } },
  65262: { name: 'ET1 — Engine Temperature 1', spns: { 110: 'Engine Coolant Temperature' } },
  65263: { name: 'EFL/P1 — Engine Fluid Level/Pressure 1', spns: { 100: 'Engine Oil Pressure' } },
  65031: { name: 'EGT1 — Exhaust Gas Temperature 1', spns: { 173: 'Engine Exhaust Gas Temperature' } },
  65253: { name: 'HOURS — Engine Hours, Revolutions', spns: { 247: 'Engine Total Hours of Operation' } },
  65266: { name: 'LFE — Fuel Economy (Liquid)', spns: { 183: 'Engine Fuel Rate' } },
  65276: { name: 'DD — Dash Display', spns: { 96: 'Fuel Level 1' } },
  65271: { name: 'VEP1 — Vehicle Electrical Power 1', spns: { 168: 'Battery Potential / Power Input 1' } },
  65110: { name: 'AT1T1I — Aftertreatment 1 DEF Tank 1 Information', spns: { 1761: 'Aftertreatment 1 DEF Tank Volume' } },
  65226: { name: 'DM1 — Active Diagnostic Trouble Codes', spns: {} },
};

const GATEWAY_MANIFESTS = {
  'TCU-G1': {
    family: 'TCU-G1',
    hardware: 'Talon TCU-G1 (Telit LE910)',
    firmware: '1.14.6',
    modem: 'LTE Cat-1 / 3G fallback',
    canBus: 'SAE J1939 @ 250 kbit/s',
    payloadFormat: 'csv-legacy',
    reportIntervalSec: 120,
    heartbeatMin: 30,
    manifestVersion: 2,
    dm1: { pgn: 65226, spnConversionMethod: 1 },
    pgns: [61444, 65262, 65263, 65253, 65266, 65276, 65271, 65226],
    topic: 'talon/connect/g1/{assetId}/up',
  },
  'TCU-G2': {
    family: 'TCU-G2',
    hardware: 'Talon TCU-G2 (Quectel EG25-G)',
    firmware: '2.8.3',
    modem: 'LTE Cat-4',
    canBus: 'SAE J1939 @ 250 kbit/s',
    payloadFormat: 'protobuf-v2',
    reportIntervalSec: 60,
    heartbeatMin: 15,
    manifestVersion: 4,
    dm1: { pgn: 65226, spnConversionMethod: 3 },
    pgns: [61444, 65262, 65263, 65031, 65253, 65266, 65276, 65271, 65110, 65226],
    topic: 'talon/connect/g2/{assetId}/up',
  },
  'TCU-G3': {
    family: 'TCU-G3',
    hardware: 'Talon TCU-G3 (Quectel BG95-M3 + GNSS)',
    firmware: '3.2.0 (OTA rollout 2026-09-24)',
    modem: 'LTE-M / NB-IoT',
    canBus: 'SAE J1939 @ 500 kbit/s',
    payloadFormat: 'protobuf-v3',
    reportIntervalSec: 30,
    heartbeatMin: 5,
    manifestVersion: 5,
    dm1: { pgn: 65226, spnConversionMethod: 4 },
    pgns: [61444, 65262, 65263, 65031, 65253, 65266, 65276, 65271, 65110, 65226],
    topic: 'talon/connect/g3/{assetId}/up',
  },
};

function getGatewayManifest(family) {
  return Object.prototype.hasOwnProperty.call(GATEWAY_MANIFESTS, family) ? GATEWAY_MANIFESTS[family] : null;
}

module.exports = { GATEWAY_MANIFESTS, PGN_DECODE, getGatewayManifest };
