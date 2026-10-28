/**
 * Approved COBOL → Java / Aurora PostgreSQL conversion rules for the Sysco
 * nightly inventory close modernization (signed off by the principal
 * architect for the POC).
 *
 * PIC_RULES     copybook picture classes → Java type + Aurora column type.
 * ROUNDING      COBOL arithmetic phrase → java.math.RoundingMode. COBOL
 *               truncates unless the receiving field is ROUNDED, and ROUNDED
 *               rounds half away from zero.
 * PARITY        tolerance the parallel run allows between the legacy focus
 *               file and the modernized output, per column class.
 */
const PIC_RULES = {
  ALPHANUMERIC: { java: 'String', aurora: 'VARCHAR', keepLength: true },
  UNSIGNED_INTEGER: { java: 'Long', aurora: 'BIGINT' },
  SIGNED_INTEGER: { java: 'Long', aurora: 'BIGINT' },
  UNSIGNED_DECIMAL: { java: 'BigDecimal', aurora: 'NUMERIC', keepPrecision: true },
  SIGNED_DECIMAL: { java: 'BigDecimal', aurora: 'NUMERIC', keepPrecision: true },
  PACKED_DECIMAL: { java: 'BigDecimal', aurora: 'NUMERIC', keepPrecision: true },
  DATE_CCYYMMDD: { java: 'LocalDate', aurora: 'DATE' },
};

const ROUNDING = {
  ROUNDED: 'HALF_UP',
  TRUNCATED: 'DOWN',
};

const PARITY = {
  ledgerAmount: { tolerance: 0, note: 'Ledger and cost amounts must match the legacy output to the cent. No tolerance.' },
  weight: { tolerance: 0, note: 'Catch weights must match to the declared scale.' },
  quantity: { tolerance: 0, note: 'Case and each quantities must match exactly.' },
};

module.exports = { PIC_RULES, ROUNDING, PARITY };
