/**
 * 631ad31e — migration catalog for the Teradata EDW → Databricks Lakehouse
 * program shown in the Migration Cockpit.
 *
 * Waves, source tables and their Teradata DDL are a synthetic model built for
 * this demo; they do not describe the customer's real warehouse.
 */

const PROGRAM = {
  name: 'EDW Modernization — Teradata to Databricks',
  source: 'Teradata EDW (TDPROD01)',
  target: 'Databricks Lakehouse · Unity Catalog td_prod',
  targetCutover: '2027-02-15',
  totals: {
    objects: 4960,
    objectsMigrated: 3412,
    dataTb: 598.4,
    dataTbMoved: 412.6,
    workloads: 1730,
    workloadsCutOver: 1184,
    rowParity: 99.97,
  },
};

const WAVES = [
  {
    id: 'W1', name: 'Customer & Party', database: 'EDW_PTY', status: 'complete', objects: 612, migrated: 612, dataTb: 88.1,
  },
  {
    id: 'W2', name: 'Cards & Payments', database: 'EDW_CRD', status: 'complete', objects: 1148, migrated: 1148, dataTb: 141.7,
  },
  {
    id: 'W3', name: 'Deposits & Balances', database: 'EDW_DEP', status: 'checkpoint', objects: 1264, migrated: 1022, dataTb: 131.9,
  },
  {
    id: 'W4', name: 'Retail Lending', database: 'EDW_LND', status: 'running', objects: 986, migrated: 630, dataTb: 118.2,
  },
  {
    id: 'W5', name: 'Wealth & Direct Investing', database: 'EDW_WLT', status: 'queued', objects: 574, migrated: 0, dataTb: 64.8,
  },
  {
    id: 'W6', name: 'Risk & Finance', database: 'EDW_FIN', status: 'planned', objects: 376, migrated: 0, dataTb: 53.7,
  },
];

/**
 * Tables still to land for a wave, with the Teradata column definitions the
 * schema mapper works from.
 */
const WAVE_TABLES = {
  W3: [
    {
      database: 'EDW_DEP',
      name: 'DEP_ACCT',
      rows: 48211904,
      columns: [
        { name: 'ACCT_ID', type: 'DECIMAL(18,0)', nullable: false },
        { name: 'PARTY_ID', type: 'DECIMAL(18,0)', nullable: false },
        { name: 'PRODUCT_CD', type: 'CHAR(6)', nullable: false },
        { name: 'BRANCH_TRANSIT', type: 'CHAR(5)', nullable: false },
        { name: 'OPEN_DT', type: 'DATE', nullable: false },
        { name: 'ACCT_STATUS_CD', type: 'BYTEINT', nullable: false },
        { name: 'CURRENCY_CD', type: 'CHAR(3)', nullable: false },
        { name: 'LAST_UPD_TS', type: 'TIMESTAMP(6) WITH TIME ZONE', nullable: true },
      ],
    },
    {
      database: 'EDW_DEP',
      name: 'DEP_ACCT_BAL_HIST',
      rows: 2614338120,
      columns: [
        { name: 'ACCT_ID', type: 'DECIMAL(18,0)', nullable: false },
        { name: 'BAL_AMT', type: 'DECIMAL(18,4)', nullable: false },
        { name: 'AVAIL_BAL_AMT', type: 'DECIMAL(18,4)', nullable: true },
        { name: 'INT_RATE_PCT', type: 'DECIMAL(9,6)', nullable: true },
        { name: 'RATE_PERIOD', type: 'PERIOD(DATE)', nullable: false },
        { name: 'SNAPSHOT_DT', type: 'DATE', nullable: false },
        { name: 'SRC_SYS_CD', type: 'VARCHAR(12)', nullable: false },
      ],
    },
    {
      database: 'EDW_DEP',
      name: 'DEP_TXN_DAILY',
      rows: 9803441266,
      columns: [
        { name: 'TXN_ID', type: 'DECIMAL(20,0)', nullable: false },
        { name: 'ACCT_ID', type: 'DECIMAL(18,0)', nullable: false },
        { name: 'TXN_TYPE_CD', type: 'CHAR(4)', nullable: false },
        { name: 'TXN_AMT', type: 'DECIMAL(18,4)', nullable: false },
        { name: 'CHANNEL_CD', type: 'VARCHAR(16)', nullable: true },
        { name: 'POSTED_TS', type: 'TIMESTAMP(6)', nullable: false },
        { name: 'MEMO_TXT', type: 'VARCHAR(255)', nullable: true },
      ],
    },
  ],
};

module.exports = {
  PROGRAM,
  WAVES,
  WAVE_TABLES,
};
