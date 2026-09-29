/**
 * Distribution grid reference data for the outage status lookup: service
 * points (premises) keyed to the circuit that feeds them, plus the circuit
 * snapshots the outage management system publishes every few minutes.
 */

const SERVICE_POINTS = [
  { premiseId: 'P-0412-88213', address: '300 LAKESIDE DR', city: 'OAKLAND', state: 'CA', zip: '94612', circuitId: 'OAK-1104', meters: 1 },
  { premiseId: 'P-0412-88220', address: '300 LAKESIDE DR', city: 'FOSTER CITY', state: 'CA', zip: '94404', circuitId: 'BEL-2207', meters: 14 },
  { premiseId: 'P-0517-11930', address: '1253 LAKESIDE DR # 300', city: 'SUNNYVALE', state: 'CA', zip: '94085', circuitId: 'SUN-0312', meters: 1 },
  { premiseId: 'P-0517-11931', address: '1250 LAKESIDE DR APT 300', city: 'SUNNYVALE', state: 'CA', zip: '94085', circuitId: 'SUN-0312', meters: 1 },
  { premiseId: 'P-0517-11932', address: '1252 LAKESIDE DR UNIT 300', city: 'SUNNYVALE', state: 'CA', zip: '94085', circuitId: 'SUN-0312', meters: 1 },
  { premiseId: 'P-0517-11940', address: '1245 LAKESIDE DR APT 3003 BLDG 1', city: 'SUNNYVALE', state: 'CA', zip: '94085', circuitId: 'SUN-0312', meters: 1 },
  { premiseId: 'P-0517-11941', address: '1245 LAKESIDE DR APT 3005 BLDG 1', city: 'SUNNYVALE', state: 'CA', zip: '94085', circuitId: 'SUN-0312', meters: 1 },
  { premiseId: 'P-0517-11942', address: '1245 LAKESIDE DR APT 3007 BLDG 1', city: 'SUNNYVALE', state: 'CA', zip: '94085', circuitId: 'SUN-0312', meters: 1 },
  { premiseId: 'P-0517-11943', address: '1245 LAKESIDE DR APT 3009 BLDG 1', city: 'SUNNYVALE', state: 'CA', zip: '94085', circuitId: 'SUN-0312', meters: 1 },
  { premiseId: 'P-0517-11944', address: '1245 LAKESIDE DR APT 3011 BLDG 1', city: 'SUNNYVALE', state: 'CA', zip: '94085', circuitId: 'SUN-0312', meters: 1 },
  { premiseId: 'P-0301-40011', address: '77 BEALE ST', city: 'SAN FRANCISCO', state: 'CA', zip: '94105', circuitId: 'SFO-0871', meters: 6 },
  { premiseId: 'P-0301-40122', address: '1 DR CARLTON B GOODLETT PL', city: 'SAN FRANCISCO', state: 'CA', zip: '94102', circuitId: 'SFO-0655', meters: 3 },
  { premiseId: 'P-0301-40390', address: '1234 MARKET ST', city: 'SAN FRANCISCO', state: 'CA', zip: '94103', circuitId: 'SFO-0655', meters: 1 },
  { premiseId: 'P-0301-41077', address: '2500 24TH AVE', city: 'SAN FRANCISCO', state: 'CA', zip: '94116', circuitId: 'SFO-1210', meters: 1 },
  { premiseId: 'P-0412-80101', address: '1 FRANK H OGAWA PLZ', city: 'OAKLAND', state: 'CA', zip: '94612', circuitId: 'OAK-1104', meters: 2 },
  { premiseId: 'P-0412-80455', address: '2150 ALLSTON WAY', city: 'BERKELEY', state: 'CA', zip: '94704', circuitId: 'BRK-0430', meters: 1 },
  { premiseId: 'P-0412-80980', address: '4200 PARK BLVD', city: 'OAKLAND', state: 'CA', zip: '94602', circuitId: 'OAK-1191', meters: 1 },
  { premiseId: 'P-0412-81204', address: '3300 LAKESHORE AVE', city: 'OAKLAND', state: 'CA', zip: '94610', circuitId: 'OAK-1104', meters: 1 },
  { premiseId: 'P-0412-81760', address: '300 LAKESHORE AVE', city: 'OAKLAND', state: 'CA', zip: '94606', circuitId: 'OAK-1104', meters: 1 },
  { premiseId: 'P-0640-20211', address: '200 E SANTA CLARA ST', city: 'SAN JOSE', state: 'CA', zip: '95113', circuitId: 'SJC-0908', meters: 4 },
  { premiseId: 'P-0640-20870', address: '1 INFINITE LOOP', city: 'CUPERTINO', state: 'CA', zip: '95014', circuitId: 'CUP-0117', meters: 9 },
  { premiseId: 'P-0640-21133', address: '3000 EL CAMINO REAL', city: 'PALO ALTO', state: 'CA', zip: '94306', circuitId: 'PAL-0504', meters: 1 },
  { premiseId: 'P-0640-21540', address: '300 LAKESIDE DR', city: 'REDWOOD CITY', state: 'CA', zip: '94065', circuitId: 'BEL-2207', meters: 1 },
  { premiseId: 'P-0715-30017', address: '915 L ST', city: 'SACRAMENTO', state: 'CA', zip: '95814', circuitId: 'SAC-0221', meters: 1 },
  { premiseId: 'P-0715-30460', address: '2101 ARENA BLVD', city: 'SACRAMENTO', state: 'CA', zip: '95834', circuitId: 'SAC-0233', meters: 2 },
  { premiseId: 'P-0715-31009', address: '300 LAKESIDE DR', city: 'FOLSOM', state: 'CA', zip: '95630', circuitId: 'FOL-0612', meters: 1 },
  { premiseId: 'P-0820-50033', address: '2600 FRESNO ST', city: 'FRESNO', state: 'CA', zip: '93721', circuitId: 'FRE-0740', meters: 1 },
  { premiseId: 'P-0820-50410', address: '5241 N MAPLE AVE', city: 'FRESNO', state: 'CA', zip: '93740', circuitId: 'FRE-0745', meters: 5 },
  { premiseId: 'P-0820-51122', address: '1501 TRUXTUN AVE', city: 'BAKERSFIELD', state: 'CA', zip: '93301', circuitId: 'BAK-1002', meters: 1 },
  { premiseId: 'P-0930-60051', address: '100 SANTA ROSA AVE', city: 'SANTA ROSA', state: 'CA', zip: '95404', circuitId: 'SRO-0316', meters: 1 },
  { premiseId: 'P-0930-60380', address: '955 SCHOOL ST', city: 'NAPA', state: 'CA', zip: '94559', circuitId: 'NAP-0208', meters: 1 },
  { premiseId: 'P-0930-60902', address: '1601 LAKESIDE DR', city: 'CALISTOGA', state: 'CA', zip: '94515', circuitId: 'CAL-0119', meters: 1 },
  { premiseId: 'P-0930-61240', address: '19400 LAKESIDE DR', city: 'MIDDLETOWN', state: 'CA', zip: '95461', circuitId: 'MID-0044', meters: 1 },
  { premiseId: 'P-1040-70015', address: '411 MAIN ST', city: 'CHICO', state: 'CA', zip: '95928', circuitId: 'CHI-0507', meters: 1 },
  { premiseId: 'P-1040-70333', address: '5555 SKYWAY', city: 'PARADISE', state: 'CA', zip: '95969', circuitId: 'PAR-0110', meters: 1 },
  { premiseId: 'P-1040-70801', address: '1400 LAKESIDE DR', city: 'REDDING', state: 'CA', zip: '96001', circuitId: 'RED-0620', meters: 1 },
  { premiseId: 'P-1150-90012', address: '425 N EL DORADO ST', city: 'STOCKTON', state: 'CA', zip: '95202', circuitId: 'STK-0415', meters: 1 },
  { premiseId: 'P-1150-90277', address: '1010 10TH ST', city: 'MODESTO', state: 'CA', zip: '95354', circuitId: 'MOD-0333', meters: 1 },
  { premiseId: 'P-1260-95003', address: '1 GARDEN ST', city: 'SANTA CRUZ', state: 'CA', zip: '95060', circuitId: 'SCZ-0206', meters: 1 },
  { premiseId: 'P-1260-95441', address: '580 PACIFIC ST', city: 'MONTEREY', state: 'CA', zip: '93940', circuitId: 'MRY-0128', meters: 1 },
  { premiseId: 'P-1370-99120', address: '990 PALM ST', city: 'SAN LUIS OBISPO', state: 'CA', zip: '93401', circuitId: 'SLO-0311', meters: 1 },
];

const CIRCUITS = {
  'OAK-1104': { circuitId: 'OAK-1104', name: 'Grand Lake 1104', substation: 'Oakland K', division: 'East Bay', county: { name: 'Alameda', withPower: 99.9, currentOutages: 3, customersAffected: 35 } },
  'OAK-1191': { circuitId: 'OAK-1191', name: 'Dimond 1191', substation: 'Oakland J', division: 'East Bay', county: { name: 'Alameda', withPower: 99.9, currentOutages: 3, customersAffected: 35 } },
  'BRK-0430': { circuitId: 'BRK-0430', name: 'Berkeley F 0430', substation: 'Berkeley F', division: 'East Bay', county: { name: 'Alameda', withPower: 99.9, currentOutages: 3, customersAffected: 35 } },
  'BEL-2207': { circuitId: 'BEL-2207', name: 'Belmont 2207', substation: 'Belmont', division: 'Peninsula', county: { name: 'San Mateo', withPower: 99.9, currentOutages: 2, customersAffected: 41 } },
  'SUN-0312': { circuitId: 'SUN-0312', name: 'Sunnyvale 0312', substation: 'Wolfe', division: 'De Anza', county: { name: 'Santa Clara', withPower: 99.9, currentOutages: 5, customersAffected: 88 } },
  'SFO-0871': { circuitId: 'SFO-0871', name: 'Embarcadero 0871', substation: 'Embarcadero', division: 'San Francisco', county: { name: 'San Francisco', withPower: 99.9, currentOutages: 4, customersAffected: 112 } },
  'SFO-0655': { circuitId: 'SFO-0655', name: 'Mission 0655', substation: 'Mission', division: 'San Francisco', county: { name: 'San Francisco', withPower: 99.9, currentOutages: 4, customersAffected: 112 } },
  'SFO-1210': { circuitId: 'SFO-1210', name: 'Sunset 1210', substation: 'Larkin', division: 'San Francisco', county: { name: 'San Francisco', withPower: 99.9, currentOutages: 4, customersAffected: 112 } },
  'SJC-0908': { circuitId: 'SJC-0908', name: 'San Jose A 0908', substation: 'San Jose A', division: 'San Jose', county: { name: 'Santa Clara', withPower: 99.9, currentOutages: 5, customersAffected: 88 } },
  'CUP-0117': { circuitId: 'CUP-0117', name: 'Stelling 0117', substation: 'Stelling', division: 'De Anza', county: { name: 'Santa Clara', withPower: 99.9, currentOutages: 5, customersAffected: 88 } },
  'PAL-0504': { circuitId: 'PAL-0504', name: 'Los Altos 0504', substation: 'Los Altos', division: 'Peninsula', county: { name: 'Santa Clara', withPower: 99.9, currentOutages: 5, customersAffected: 88 } },
  'SAC-0221': { circuitId: 'SAC-0221', name: 'Downtown 0221', substation: 'Station A', division: 'Sacramento', county: { name: 'Sacramento', withPower: 99.9, currentOutages: 1, customersAffected: 9 } },
  'SAC-0233': { circuitId: 'SAC-0233', name: 'Natomas 0233', substation: 'Natomas', division: 'Sacramento', county: { name: 'Sacramento', withPower: 99.9, currentOutages: 1, customersAffected: 9 } },
  'FOL-0612': { circuitId: 'FOL-0612', name: 'Folsom 0612', substation: 'Folsom', division: 'Sierra', county: { name: 'Sacramento', withPower: 99.9, currentOutages: 1, customersAffected: 9 } },
  'FRE-0740': { circuitId: 'FRE-0740', name: 'Fresno 0740', substation: 'Kearney', division: 'Fresno', county: { name: 'Fresno', withPower: 99.8, currentOutages: 6, customersAffected: 214 } },
  'FRE-0745': { circuitId: 'FRE-0745', name: 'Herndon 0745', substation: 'Herndon', division: 'Fresno', county: { name: 'Fresno', withPower: 99.8, currentOutages: 6, customersAffected: 214 } },
  'BAK-1002': { circuitId: 'BAK-1002', name: 'Bakersfield 1002', substation: 'Kern', division: 'Kern', county: { name: 'Kern', withPower: 99.9, currentOutages: 2, customersAffected: 57 } },
  'SRO-0316': { circuitId: 'SRO-0316', name: 'Fulton 0316', substation: 'Fulton', division: 'Sonoma', county: { name: 'Sonoma', withPower: 99.9, currentOutages: 3, customersAffected: 64 } },
  'NAP-0208': { circuitId: 'NAP-0208', name: 'Napa 0208', substation: 'Napa', division: 'Napa', county: { name: 'Napa', withPower: 100, currentOutages: 0, customersAffected: 0 } },
  'CAL-0119': { circuitId: 'CAL-0119', name: 'Calistoga 0119', substation: 'Calistoga', division: 'Napa', county: { name: 'Napa', withPower: 100, currentOutages: 0, customersAffected: 0 } },
  'MID-0044': { circuitId: 'MID-0044', name: 'Middletown 0044', substation: 'Middletown', division: 'Sonoma', county: { name: 'Lake', withPower: 99.7, currentOutages: 2, customersAffected: 120 } },
  'CHI-0507': { circuitId: 'CHI-0507', name: 'Chico 0507', substation: 'Table Mountain', division: 'North Valley', county: { name: 'Butte', withPower: 99.9, currentOutages: 1, customersAffected: 18 } },
  'PAR-0110': { circuitId: 'PAR-0110', name: 'Paradise 0110', substation: 'Paradise', division: 'North Valley', county: { name: 'Butte', withPower: 99.9, currentOutages: 1, customersAffected: 18 } },
  'RED-0620': { circuitId: 'RED-0620', name: 'Redding 0620', substation: 'Cascade', division: 'North Valley', county: { name: 'Shasta', withPower: 100, currentOutages: 0, customersAffected: 0 } },
  'STK-0415': { circuitId: 'STK-0415', name: 'Stockton A 0415', substation: 'Stockton A', division: 'Stockton', county: { name: 'San Joaquin', withPower: 99.9, currentOutages: 2, customersAffected: 33 } },
  'MOD-0333': { circuitId: 'MOD-0333', name: 'Modesto 0333', substation: 'Modesto', division: 'Yosemite', county: { name: 'Stanislaus', withPower: 100, currentOutages: 0, customersAffected: 0 } },
  'SCZ-0206': { circuitId: 'SCZ-0206', name: 'Santa Cruz 0206', substation: 'Santa Cruz', division: 'Central Coast', county: { name: 'Santa Cruz', withPower: 99.9, currentOutages: 1, customersAffected: 22 } },
  'MRY-0128': { circuitId: 'MRY-0128', name: 'Monterey 0128', substation: 'Monterey', division: 'Central Coast', county: { name: 'Monterey', withPower: 99.9, currentOutages: 2, customersAffected: 46 } },
  'SLO-0311': { circuitId: 'SLO-0311', name: 'San Luis Obispo 0311', substation: 'San Luis Obispo', division: 'Los Padres', county: { name: 'San Luis Obispo', withPower: 100, currentOutages: 0, customersAffected: 0 } },
};

const SYSTEM_SITUATION = { withPower: 99.9, currentOutages: 60, customersAffected: 723 };

function formatServicePoint(point) {
  return `${point.address} ${point.city} ${point.state} ${point.zip}`;
}

function normalizeQuery(text) {
  return String(text || '').toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function searchServicePoints(query, limit = 10) {
  const terms = normalizeQuery(query).split(' ').filter(Boolean);
  if (terms.length === 0) return [];
  return SERVICE_POINTS
    .filter((point) => {
      const label = formatServicePoint(point);
      return terms.every((term) => label.includes(term));
    })
    .slice(0, limit)
    .map((point) => ({
      premiseId: point.premiseId,
      label: formatServicePoint(point),
      multipleMeters: point.meters > 1,
    }));
}

function findServicePoint(label) {
  const wanted = normalizeQuery(label);
  return SERVICE_POINTS.find((point) => formatServicePoint(point) === wanted) || null;
}

/**
 * Circuit snapshots come from the outage management system's cache; the
 * read is asynchronous because the cache is refreshed out of band.
 */
function loadCircuitSnapshot(circuitId) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const circuit = CIRCUITS[circuitId];
      resolve(circuit ? {
        circuit,
        county: circuit.county,
        activeOutages: [],
        pspsEvents: [],
        asOf: new Date().toISOString(),
      } : null);
    }, 15 + Math.random() * 25);
  });
}

module.exports = {
  SERVICE_POINTS,
  CIRCUITS,
  SYSTEM_SITUATION,
  formatServicePoint,
  searchServicePoints,
  findServicePoint,
  loadCircuitSnapshot,
};
