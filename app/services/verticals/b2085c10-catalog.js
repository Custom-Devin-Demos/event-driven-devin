/**
 * b2085c10 — migration catalog for the Teradata EDW → Databricks Lakehouse
 * program shown in the Migration Cockpit.
 *
 * Waves, source tables and their Teradata DDL are a synthetic model built for
 * this demo; they do not describe the customer's real warehouse.
 */

const PROGRAM = {
  name: 'EDW Modernization — Teradata to Databricks',
  source: 'Teradata EDW (NDWPROD01)',
  target: 'Databricks Lakehouse · Unity Catalog nord_prod',
  targetCutover: '2027-02-15',
  totals: {
    objects: 5120,
    objectsMigrated: 3538,
    dataTb: 642.9,
    dataTbMoved: 447.3,
    workloads: 1865,
    workloadsCutOver: 1262,
    rowParity: 99.97,
  },
};

const WAVES = [
  {
    id: 'W1', name: 'Customer & Nordy Club', database: 'EDW_CUST', status: 'complete', objects: 684, migrated: 684, dataTb: 92.4,
  },
  {
    id: 'W2', name: 'Orders & Fulfillment', database: 'EDW_ORD', status: 'complete', objects: 1212, migrated: 1212, dataTb: 158.3,
  },
  {
    id: 'W3', name: 'Pricing & Promotions', database: 'EDW_PRC', status: 'checkpoint', objects: 1236, migrated: 1004, dataTb: 124.6,
  },
  {
    id: 'W4', name: 'Inventory & Supply Chain', database: 'EDW_INV', status: 'running', objects: 1048, migrated: 638, dataTb: 139.5,
  },
  {
    id: 'W5', name: 'Merchandise Planning', database: 'EDW_MRC', status: 'queued', objects: 562, migrated: 0, dataTb: 71.2,
  },
  {
    id: 'W6', name: 'Finance & Store Ops', database: 'EDW_FIN', status: 'planned', objects: 378, migrated: 0, dataTb: 56.9,
  },
];

/**
 * Tables still to land for a wave, with the Teradata column definitions the
 * schema mapper works from.
 */
const WAVE_TABLES = {
  W3: [
    {
      database: 'EDW_PRC',
      name: 'PRC_ITEM_PRICE',
      rows: 61482730,
      columns: [
        { name: 'SKU_ID', type: 'DECIMAL(18,0)', nullable: false },
        { name: 'STYLE_ID', type: 'DECIMAL(18,0)', nullable: false },
        { name: 'CHANNEL_CD', type: 'CHAR(4)', nullable: false },
        { name: 'STORE_NUM', type: 'CHAR(5)', nullable: false },
        { name: 'EFFECTIVE_DT', type: 'DATE', nullable: false },
        { name: 'PRICE_TYPE_CD', type: 'BYTEINT', nullable: false },
        { name: 'CURRENCY_CD', type: 'CHAR(3)', nullable: false },
        { name: 'LAST_UPD_TS', type: 'TIMESTAMP(6) WITH TIME ZONE', nullable: true },
      ],
    },
    {
      database: 'EDW_PRC',
      name: 'PRC_PROMO_EVENT_HIST',
      rows: 2847106552,
      columns: [
        { name: 'SKU_ID', type: 'DECIMAL(18,0)', nullable: false },
        { name: 'PROMO_PRICE_AMT', type: 'DECIMAL(18,4)', nullable: false },
        { name: 'REG_PRICE_AMT', type: 'DECIMAL(18,4)', nullable: true },
        { name: 'DISCOUNT_PCT', type: 'DECIMAL(9,6)', nullable: true },
        { name: 'PROMO_PERIOD', type: 'PERIOD(DATE)', nullable: false },
        { name: 'SNAPSHOT_DT', type: 'DATE', nullable: false },
        { name: 'SRC_SYS_CD', type: 'VARCHAR(12)', nullable: false },
      ],
    },
    {
      database: 'EDW_PRC',
      name: 'PRC_MARKDOWN_DAILY',
      rows: 9412587301,
      columns: [
        { name: 'MARKDOWN_ID', type: 'DECIMAL(20,0)', nullable: false },
        { name: 'SKU_ID', type: 'DECIMAL(18,0)', nullable: false },
        { name: 'MARKDOWN_TYPE_CD', type: 'CHAR(4)', nullable: false },
        { name: 'MARKDOWN_AMT', type: 'DECIMAL(18,4)', nullable: false },
        { name: 'CHANNEL_CD', type: 'VARCHAR(16)', nullable: true },
        { name: 'POSTED_TS', type: 'TIMESTAMP(6)', nullable: false },
        { name: 'REASON_TXT', type: 'VARCHAR(255)', nullable: true },
      ],
    },
  ],
};

module.exports = {
  PROGRAM,
  WAVES,
  WAVE_TABLES,
};
