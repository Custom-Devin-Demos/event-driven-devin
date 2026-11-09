const LINE_LABELS = {
  internet: 'Internet',
  tv: 'TV',
  mobile: 'Mobile',
  voice: 'Home Phone',
};

const HOUSEHOLDS = [
  {
    accountNumber: '8352 10 004 1187320',
    firstName: 'Jordan',
    serviceZip: '28202',
    footprint: 'Carolinas',
    lines: [
      { code: 'internet', planCode: 'INT-500', equipment: ['WiFi 7 Router', 'Spectrum Modem'] },
      { code: 'mobile', planCode: 'MOB-UNL-PLUS', equipment: [] },
    ],
  },
  {
    accountNumber: '8245 12 778 0019455',
    firstName: 'Priya',
    serviceZip: '10001',
    footprint: 'Northeast',
    lines: [
      { code: 'internet', planCode: 'INT-1G', equipment: ['WiFi 7 Router'] },
      { code: 'tv', planCode: 'TV-SELECT', equipment: ['Spectrum Receiver'] },
    ],
  },
];

function lineLabel(code) {
  return LINE_LABELS[code] || code;
}

function resolveHousehold({ serviceZip, deviceId }) {
  const match = HOUSEHOLDS.find((h) => h.serviceZip === serviceZip) || HOUSEHOLDS[0];
  const services = {};
  match.lines.forEach((line) => {
    services[line.code] = { ...line, label: lineLabel(line.code) };
  });
  return {
    accountNumber: match.accountNumber,
    firstName: match.firstName,
    footprint: match.footprint,
    deviceId: deviceId || null,
    primaryLine: lineLabel(match.lines[0].code),
    services,
  };
}

module.exports = { resolveHousehold, lineLabel, HOUSEHOLDS };
