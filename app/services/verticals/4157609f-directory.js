const DIRECTORY_RECORDS = [
  {
    payIdType: 'email',
    payId: 'jess.tran@example.com.au',
    displayName: 'Jess Tran',
    accountName: 'J TRAN',
    bsb: '062-000',
    accountNumber: '10345678',
    participant: 'CBA',
    registeredAt: '2024-03-11T02:14:00Z',
  },
  {
    payIdType: 'phone',
    payId: '+61412345678',
    displayName: 'Marcus Field',
    accountName: 'M FIELD',
    bsb: '082-001',
    accountNumber: '55910233',
    participant: 'NAB',
    registeredAt: '2023-08-22T23:41:00Z',
  },
  {
    payIdType: 'abn',
    payId: '51 824 753 556',
    displayName: null,
    accountName: 'HARBOURLINE LOGISTICS PTY LTD',
    bsb: '063-104',
    accountNumber: '10998812',
    participant: 'CBA',
    registeredAt: '2022-11-30T04:05:00Z',
  },
  {
    payIdType: 'abn',
    payId: '33 102 417 988',
    displayName: null,
    accountName: 'KIRRIBILLI DENTAL GROUP PTY LTD',
    bsb: '013-006',
    accountNumber: '20417711',
    participant: 'ANZ',
    registeredAt: '2023-05-17T01:28:00Z',
  },
];

function lookupPayId(payIdType, payId) {
  const wanted = String(payId).replace(/\s+/g, '');
  const record = DIRECTORY_RECORDS.find(
    (entry) => entry.payIdType === payIdType && entry.payId.replace(/\s+/g, '') === wanted,
  );
  if (!record) {
    throw new Error(`PayID not found in NPP directory: ${payIdType}:${payId}`);
  }
  return {
    ...record,
    resolvedAt: new Date().toISOString(),
    directory: 'NPP Addressing Service',
    region: 'ap-southeast-2',
  };
}

module.exports = { lookupPayId, DIRECTORY_RECORDS };
