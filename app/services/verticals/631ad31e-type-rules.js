/**
 * Approved Teradata → Delta Lake type mappings for the EDW modernization
 * program (signed off by the data architecture review board).
 *
 * `target`    Delta type the column lands as.
 * `keepArgs`  carry the Teradata precision/scale/length arguments across.
 * `strategy`  'split' lands one source column as several target columns,
 *             named with `suffixes`, one Delta type per entry in `target`.
 */
const TYPE_RULES = {
  BYTEINT: { target: 'TINYINT' },
  SMALLINT: { target: 'SMALLINT' },
  INTEGER: { target: 'INT' },
  BIGINT: { target: 'BIGINT' },
  DECIMAL: { target: 'DECIMAL', keepArgs: true },
  NUMBER: { target: 'DECIMAL', keepArgs: true },
  FLOAT: { target: 'DOUBLE' },
  CHAR: { target: 'STRING' },
  VARCHAR: { target: 'STRING' },
  CLOB: { target: 'STRING' },
  DATE: { target: 'DATE' },
  TIMESTAMP: { target: 'TIMESTAMP_NTZ' },
  'TIMESTAMP WITH TIME ZONE': { target: 'TIMESTAMP' },
  'PERIOD(DATE)': { strategy: 'split', target: ['DATE', 'DATE'], suffixes: ['_START', '_END'] },
  'PERIOD(TIMESTAMP)': { strategy: 'split', target: ['TIMESTAMP_NTZ', 'TIMESTAMP_NTZ'], suffixes: ['_START', '_END'] },
};

module.exports = { TYPE_RULES };
