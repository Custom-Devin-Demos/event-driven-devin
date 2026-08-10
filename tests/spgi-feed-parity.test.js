jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const fs = require('fs');

const {
  runParityCheck,
  resolveFeedContract,
  normalizeLegacyRow,
  normalizeMigratedRow,
  publishFeedBatch,
  LEGACY_INSTRUMENT_CLASS_CODES,
  LEGACY_PRICE_SCALES,
  SAMPLE_BATCH,
  FEED_CONTRACT,
} = require('../app/services/verticals/da6578ee');

const {
  buildFeedContract, encodeContract, readSpec, serialize, ARTIFACT_PATH,
} = require('../pipelines/spgi/build-feed-contract');
const { auditInstrumentClass, publishableClasses } = require('../scripts/spgi-parity-audit');

const spec = readSpec();

describe('feed contract build', () => {
  test('encodes every contract over the full target column vocabulary', () => {
    const built = buildFeedContract(spec);

    Object.values(built.contracts).forEach((contract) => {
      expect(Object.keys(contract.columns)).toEqual(spec.columnVocabulary);
    });
  });

  test('fails the build when a contract declares no columns rather than shipping an empty mapping', () => {
    expect(() => encodeContract({ priceScale: 1 }, ['price_close'], 'equity_adr'))
      .toThrow(/equity_adr.*no columns/);
  });

  test('fails legibly on a malformed spec rather than throwing a raw TypeError', () => {
    expect(() => buildFeedContract({ contracts: {} })).toThrow(/columnVocabulary/);
    expect(() => buildFeedContract({ columnVocabulary: ['price_close'] })).toThrow(/contracts/);
    expect(() => buildFeedContract({ columnVocabulary: ['price_close'], contracts: { equity_adr: null } }))
      .toThrow(/equity_adr.*not an object/);
  });

  test('rejects a non-positive or non-finite price scale instead of materializing it', () => {
    [0, -1, NaN, Infinity].forEach((priceScale) => {
      expect(() => encodeContract({ priceScale, columns: { price_close: 'PX_LAST' } }, ['price_close'], 'equity_common'))
        .toThrow(/equity_common.*price scale/);
    });
  });

  test('rejects source fields keyed to columns outside the vocabulary instead of dropping them', () => {
    expect(() => encodeContract(
      { priceScale: 1, columns: { price_close: 'PX_LAST', price_ccy: 'PX_CCY' } },
      ['price_close', 'price_currency'],
      'equity_common',
    )).toThrow(/equity_common.*"price_ccy".*vocabulary/);
  });

  test('committed artifact matches a fresh build of the spec byte for byte', () => {
    expect(fs.readFileSync(ARTIFACT_PATH, 'utf8')).toBe(serialize(buildFeedContract(spec)));
  });
});

describe('parity harness', () => {
  test('legacy and migrated normalization agree on every contracted class', () => {
    SAMPLE_BATCH
      .filter((row) => resolveFeedContract(row.instrumentClass).mapped)
      .forEach((row) => {
        expect(normalizeMigratedRow(row)).toEqual(normalizeLegacyRow(row));
      });
  });

  test('reports a full match rate while holding uncontracted rows out of the population', () => {
    const parity = runParityCheck();

    expect(parity.matchRate).toBe(1);
    expect(parity.rowsExcluded).toBeGreaterThan(0);
    expect(parity.coverage).toBeLessThan(1);
    expect(parity.excludedClasses).toContain('depositary_receipt');
  });

  test('coverage accounts for every row the batch carried in', () => {
    const parity = runParityCheck();

    expect(parity.rowsCompared + parity.rowsExcluded).toBe(parity.rowsIn);
    expect(parity.coverage).toBeCloseTo(parity.rowsCompared / parity.rowsIn, 4);
  });

  test('sizes the blast radius of the excluded class in rows per day', () => {
    expect(runParityCheck().excludedDailyRows).toBe(2140880);
  });
});

describe('publish path', () => {
  test('throws on an instrument class the contract does not carry', async () => {
    await expect(publishFeedBatch({ jobId: 'CIQ-PX-EOD' })).rejects.toThrow(TypeError);
  });

  test('publishes cleanly when every row in the batch is contracted', async () => {
    const batch = SAMPLE_BATCH.filter((row) => resolveFeedContract(row.instrumentClass).mapped);
    const result = await publishFeedBatch({ jobId: 'CIQ-PX-EOD', batch });

    expect(result.success).toBe(true);
    expect(result.rowsPublished).toBe(batch.length);
    expect(result.parity.coverage).toBe(1);
  });
});

describe('parity coverage audit', () => {
  test('audits every class the publisher can emit, not only the ones the spec declares', () => {
    expect(publishableClasses()).toEqual(Object.keys(LEGACY_INSTRUMENT_CLASS_CODES));
    expect(publishableClasses()).toEqual(Object.keys(LEGACY_PRICE_SCALES));
  });

  test('flags the uncontracted class as outside the parity population', () => {
    const row = auditInstrumentClass('depositary_receipt');

    expect(row.declared).toBe(true);
    expect(row.mapsConsistently).toBe(true);
    expect(row.mapped).toBe(false);
    expect(row.rowsCompared).toBe(0);
    expect(row.rowsExcluded).toBe(row.sampleRows);
  });

  test('passes the classes the contract does carry', () => {
    Object.keys(FEED_CONTRACT.contracts).forEach((code) => {
      const instrumentClass = Object.keys(LEGACY_INSTRUMENT_CLASS_CODES)
        .find((key) => LEGACY_INSTRUMENT_CLASS_CODES[key] === code);
      const row = auditInstrumentClass(instrumentClass);

      expect(row.mapped).toBe(true);
      expect(row.mapsConsistently).toBe(true);
      expect(row.rowsCompared).toBe(row.sampleRows);
      expect(row.matchRate).toBe(1);
    });
  });
});
