const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/c03fbe3d/quotes';
const SERVICE = 'arrow-com-quote-service';
const SLACK_MEMBER_ID = process.env.ARROW_SLACK_MEMBER_ID || '';

const ACCOUNT = {
  name: 'Northwind Robotics Inc',
  number: '2184417',
  terms: '30 NET',
  currency: 'USD',
  billTo: '9151 E Panorama Cir, Englewood, CO 80112 US',
  shipToCountry: 'US',
  user: 'Dana Whitaker',
  insideSalesRep: 'IN HOUSE',
};

/**
 * Part master slice for the demo account. `breaks` are quantity price breaks,
 * `countryOfOrigin` drives the import-duty estimate on quotes shipped to the US.
 */
const PARTS = {
  'STM32F407VGT6': { mpn: 'STM32F407VGT6', manufacturer: 'STMicroelectronics', description: 'MCU 32-bit ARM Cortex M4 RISC 1MB Flash 3.3V 100-Pin LQFP Tray', packaging: 'Tray', stock: 4310, leadTimeWeeks: 14, lifecycle: 'Active', countryOfOrigin: 'MY', minQty: 1, multiple: 1, breaks: [[1, 11.42], [25, 10.31], [100, 9.18], [540, 8.47]], leadTimeHistory: [12, 12, 13, 14, 14, 14] },
  'LT4256-2IS8#PBF': { mpn: 'LT4256-2IS8#PBF', manufacturer: 'Analog Devices', description: 'Hot Swap Controller 1-CH 80V N-Channel Positive High Voltage 8-Pin SOIC N Tube', packaging: 'Tube', stock: 0, leadTimeWeeks: 17, lifecycle: 'Active', countryOfOrigin: 'MY', minQty: 100, multiple: 100, breaks: [[100, 3.27], [500, 3.115], [1000, 2.98]], leadTimeHistory: [10, 12, 14, 16, 17, 17], crosses: ['LT4256-1IS8#PBF', 'LM5069MM-2/NOPB'] },
  'DRV8323RSRGZR': { mpn: 'DRV8323RSRGZR', manufacturer: 'Texas Instruments', description: 'Motor Driver 3-Phase Smart Gate 65V Buck Regulator 48-Pin VQFN T/R', packaging: 'Tape & Reel', stock: 12500, leadTimeWeeks: 8, lifecycle: 'Active', countryOfOrigin: 'PH', minQty: 1, multiple: 1, breaks: [[1, 5.96], [100, 4.71], [500, 4.02], [2500, 3.58]], leadTimeHistory: [12, 10, 9, 8, 8, 8] },
  'FDMS86180': { mpn: 'FDMS86180', manufacturer: 'onsemi', description: 'MOSFET N-Channel 100V 109A PowerTrench Shielded Gate 8-Pin Power56 T/R', packaging: 'Tape & Reel', stock: 27000, leadTimeWeeks: 20, lifecycle: 'Active', countryOfOrigin: 'VN', minQty: 1, multiple: 1, breaks: [[1, 3.84], [100, 2.92], [1000, 2.31], [3000, 2.07]], leadTimeHistory: [14, 16, 18, 19, 20, 20], crosses: ['BSC040N10NS5ATMA1', 'CSD19532Q5B'] },
  'INA240A2PWR': { mpn: 'INA240A2PWR', manufacturer: 'Texas Instruments', description: 'Current Sense Amplifier 80V Bidirectional PWM Rejection 8-Pin TSSOP T/R', packaging: 'Tape & Reel', stock: 8140, leadTimeWeeks: 6, lifecycle: 'Active', countryOfOrigin: 'MX', minQty: 1, multiple: 1, breaks: [[1, 2.63], [100, 1.94], [1000, 1.51]], leadTimeHistory: [8, 7, 6, 6, 6, 6] },
  'TPS54331DR': { mpn: 'TPS54331DR', manufacturer: 'Texas Instruments', description: 'Conv DC-DC 3.5V to 28V Step Down Single-Out 3A 8-Pin SOIC T/R', packaging: 'Tape & Reel', stock: 46200, leadTimeWeeks: 6, lifecycle: 'Active', countryOfOrigin: 'MY', minQty: 1, multiple: 1, breaks: [[1, 1.37], [100, 0.912], [2500, 0.684]], leadTimeHistory: [6, 6, 6, 6, 6, 6] },
  'TJA1051T/3,118': { mpn: 'TJA1051T/3,118', manufacturer: 'NXP Semiconductors', description: 'CAN Transceiver High-Speed 5Mbps 8-Pin SO T/R', packaging: 'Tape & Reel', stock: 9800, leadTimeWeeks: 13, lifecycle: 'NRND', countryOfOrigin: 'TH', minQty: 1, multiple: 1, breaks: [[1, 1.52], [100, 1.09], [2500, 0.861]], leadTimeHistory: [10, 11, 12, 13, 13, 13], crosses: ['TJA1441AT/0Z', 'TCAN1051HVDR'] },
  'NC7SZ74K8X': { mpn: 'NC7SZ74K8X', manufacturer: 'onsemi', description: 'Flip Flop D-Type Pos-Edge 1-Element 8-Pin US8 T/R', packaging: 'Tape & Reel', stock: 25882, leadTimeWeeks: 10, lifecycle: 'Active', countryOfOrigin: 'CN', minQty: 1, multiple: 1, breaks: [[1, 0.412], [100, 0.218], [3000, 0.127]], leadTimeHistory: [10, 10, 10, 10, 10, 10], crosses: ['SN74LVC1G74DCUR'] },
  'BAV99-7-F': { mpn: 'BAV99-7-F', manufacturer: 'Diodes Incorporated', description: 'Diode Switching 100V 0.3A 3-Pin SOT-23 T/R', packaging: 'Tape & Reel', stock: 323395, leadTimeWeeks: 12, lifecycle: 'Active', countryOfOrigin: 'CN', minQty: 1, multiple: 1, breaks: [[1, 0.0454], [3000, 0.0141], [9000, 0.0118]], leadTimeHistory: [12, 12, 12, 12, 12, 12] },
  'GRM188R71H104KA93D': { mpn: 'GRM188R71H104KA93D', manufacturer: 'Murata Manufacturing', description: 'Cap Ceramic 0.1uF 50V X7R 10% Pad SMD 0603 125C T/R', packaging: 'Tape & Reel', stock: 1284000, leadTimeWeeks: 9, lifecycle: 'Active', countryOfOrigin: 'JP', minQty: 1, multiple: 1, breaks: [[1, 0.021], [4000, 0.0068], [40000, 0.0049]], leadTimeHistory: [9, 9, 9, 9, 9, 9] },
  'C0805C475K4RACTU': { mpn: 'C0805C475K4RACTU', manufacturer: 'KEMET', description: 'Cap Ceramic 4.7uF 16V X7R 10% Pad SMD 0805 125C T/R', packaging: 'Tape & Reel', stock: 96500, leadTimeWeeks: 11, lifecycle: 'Active', countryOfOrigin: 'MX', minQty: 1, multiple: 1, breaks: [[1, 0.118], [2500, 0.0708], [10000, 0.0593]], leadTimeHistory: [11, 11, 11, 11, 11, 11] },
  'CRCW060310K0FKEA': { mpn: 'CRCW060310K0FKEA', manufacturer: 'Vishay', description: 'Res Thick Film 0603 10K Ohm 1% 0.1W(1/10W) ±100ppm/C Pad SMD T/R', packaging: 'Tape & Reel', stock: 742000, leadTimeWeeks: 8, lifecycle: 'Active', countryOfOrigin: 'TW', minQty: 1, multiple: 1, breaks: [[1, 0.0102], [5000, 0.0031], [25000, 0.0024]], leadTimeHistory: [8, 8, 8, 8, 8, 8] },
  'BME280': { mpn: 'BME280', manufacturer: 'Bosch Sensortec', description: 'Sensor Humidity/Pressure/Temperature Digital 8-Pin LGA T/R', packaging: 'Tape & Reel', stock: 15300, leadTimeWeeks: 10, lifecycle: 'Active', countryOfOrigin: 'DE', minQty: 1, multiple: 1, breaks: [[1, 4.18], [100, 3.26], [1000, 2.79]], leadTimeHistory: [10, 10, 10, 10, 10, 10] },
  'SN74LVC1G14DBVR': { mpn: 'SN74LVC1G14DBVR', manufacturer: 'Texas Instruments', description: 'Inverter Schmitt Trigger 1-Element CMOS 5-Pin SOT-23 T/R', packaging: 'Tape & Reel', stock: 188000, leadTimeWeeks: 6, lifecycle: 'Active', countryOfOrigin: 'MY', minQty: 1, multiple: 1, breaks: [[1, 0.218], [100, 0.121], [3000, 0.068]], leadTimeHistory: [6, 6, 6, 6, 6, 6] },
};

/**
 * Import-duty programs applied to quotes shipped to the US, keyed by the part's
 * country of origin. `adValorem` is the duty rate on the extended price.
 */
const TARIFF_PROGRAMS = {
  CN: { program: 'Section 301 List 3', adValorem: 0.25 },
  MY: { program: 'Reciprocal', adValorem: 0.19 },
  TW: { program: 'Reciprocal', adValorem: 0.2 },
  TH: { program: 'Reciprocal', adValorem: 0.19 },
  PH: { program: 'Reciprocal', adValorem: 0.19 },
  JP: { program: 'Reciprocal', adValorem: 0.15 },
  KR: { program: 'Reciprocal', adValorem: 0.15 },
  DE: { program: 'Reciprocal (EU)', adValorem: 0.15 },
  MX: { program: 'USMCA qualifying', adValorem: 0 },
  US: { program: 'Domestic', adValorem: 0 },
};

const BOMS = {
  'BOM-70412': {
    id: 'BOM-70412', name: 'MC-4400 Motor Controller Rev C', owner: 'You', created: 'Nov 12, 2026', modified: 'Nov 18, 2026', buildQty: 500,
    lines: [
      { cpn: 'NR-100-0407', mpn: 'STM32F407VGT6', perUnit: 1 },
      { cpn: 'NR-210-4256', mpn: 'LT4256-2IS8#PBF', perUnit: 1 },
      { cpn: 'NR-220-8323', mpn: 'DRV8323RSRGZR', perUnit: 1 },
      { cpn: 'NR-300-8618', mpn: 'FDMS86180', perUnit: 6 },
      { cpn: 'NR-230-0240', mpn: 'INA240A2PWR', perUnit: 3 },
      { cpn: 'NR-240-5433', mpn: 'TPS54331DR', perUnit: 1 },
      { cpn: 'NR-250-1051', mpn: 'TJA1051T/3,118', perUnit: 1 },
      { cpn: 'NR-260-7474', mpn: 'NC7SZ74K8X', perUnit: 2 },
      { cpn: 'NR-310-0099', mpn: 'BAV99-7-F', perUnit: 6 },
      { cpn: 'NR-400-1040', mpn: 'GRM188R71H104KA93D', perUnit: 40 },
      { cpn: 'NR-400-4750', mpn: 'C0805C475K4RACTU', perUnit: 10 },
      { cpn: 'NR-500-1002', mpn: 'CRCW060310K0FKEA', perUnit: 50 },
    ],
  },
  'BOM-70388': {
    id: 'BOM-70388', name: 'SH-210 Sensor Hub Rev A', owner: 'You', created: 'Nov 3, 2026', modified: 'Nov 11, 2026', buildQty: 1000,
    lines: [
      { cpn: 'NR-100-0407', mpn: 'STM32F407VGT6', perUnit: 1 },
      { cpn: 'NR-600-0280', mpn: 'BME280', perUnit: 1 },
      { cpn: 'NR-240-5433', mpn: 'TPS54331DR', perUnit: 1 },
      { cpn: 'NR-270-1G14', mpn: 'SN74LVC1G14DBVR', perUnit: 2 },
      { cpn: 'NR-400-1040', mpn: 'GRM188R71H104KA93D', perUnit: 20 },
      { cpn: 'NR-400-4750', mpn: 'C0805C475K4RACTU', perUnit: 4 },
      { cpn: 'NR-500-1002', mpn: 'CRCW060310K0FKEA', perUnit: 12 },
    ],
  },
};

const RECENT_QUOTES = [
  { quoteNumber: '25213901', status: 'Quoted', owner: 'MyarrowNA, Prod10', partsQuoted: 7, submitted: '03-Nov-2026', expires: '18-Dec-2026', reference: 'SH-210 proto build', total: 14862.4 },
  { quoteNumber: '25209377', status: 'Quoted', owner: 'MyarrowNA, Prod10', partsQuoted: 3, submitted: '21-Oct-2026', expires: '05-Dec-2026', reference: 'PO 4500118822', total: 3921.75 },
  { quoteNumber: '25198840', status: 'Expired', owner: 'MyarrowNA, Prod10', partsQuoted: 11, submitted: '02-Sep-2026', expires: '17-Oct-2026', reference: 'MC-4400 Rev B', total: 20418.1 },
];

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Unit price at `qty` from the part's quantity breaks (highest break not above qty). */
function unitPriceAt(part, qty) {
  let price = part.breaks[0][1];
  for (const [breakQty, breakPrice] of part.breaks) {
    if (qty >= breakQty) price = breakPrice;
  }
  return price;
}

/** Rounds a requested quantity up to the part's minimum and order multiple. */
function orderQuantity(part, requested) {
  const qty = Math.max(requested, part.minQty);
  return Math.ceil(qty / part.multiple) * part.multiple;
}

function describeLine(line, buildQty) {
  const part = PARTS[line.mpn];
  const requested = line.perUnit * buildQty;
  const quantity = orderQuantity(part, requested);
  const unitPrice = unitPriceAt(part, quantity);
  return {
    cpn: line.cpn, mpn: part.mpn, manufacturer: part.manufacturer, description: part.description, packaging: part.packaging,
    perUnit: line.perUnit, requested, quantity, unitPrice, startingAt: part.breaks[part.breaks.length - 1][1],
    extended: round2(unitPrice * quantity),
    stock: part.stock, available: Math.min(part.stock, quantity), leadTimeWeeks: part.leadTimeWeeks,
    minQty: part.minQty, multiple: part.multiple,
    lifecycle: part.lifecycle, countryOfOrigin: part.countryOfOrigin, tariffApplies: part.countryOfOrigin !== ACCOUNT.shipToCountry,
    leadTimeHistory: part.leadTimeHistory, crosses: part.crosses || [],
  };
}

function summarizeBom(bom) {
  return { id: bom.id, name: bom.name, owner: bom.owner, created: bom.created, modified: bom.modified, totalParts: bom.lines.length, buildQty: bom.buildQty };
}

function listBoms() {
  return { account: ACCOUNT, boms: Object.values(BOMS).map(summarizeBom), quotes: RECENT_QUOTES };
}

function getBom(bomId) {
  const bom = BOMS[bomId];
  const lines = bom.lines.map((l) => describeLine(l, bom.buildQty));
  const inStock = lines.filter((l) => l.stock >= l.quantity).length;
  return {
    ...summarizeBom(bom),
    lines,
    counts: {
      inStock, outOfStock: lines.filter((l) => l.stock === 0).length,
      quantityConflict: lines.filter((l) => l.stock > 0 && l.stock < l.quantity).length,
      crosses: lines.filter((l) => l.crosses.length > 0).length, noMatch: 0, alternates: 0,
    },
    requestedTotal: round2(lines.reduce((sum, l) => sum + l.extended, 0)),
    availableTotal: round2(lines.reduce((sum, l) => sum + l.unitPrice * l.available, 0)),
  };
}

/**
 * Prices one quote line including the estimated import duty for the bill-to's ship-to country.
 */
function quoteLine(line, shipToCountry) {
  const part = PARTS[line.mpn];
  const extended = round2(line.unitPrice * line.quantity);
  const tariff = shipToCountry === 'US' ? TARIFF_PROGRAMS[part.countryOfOrigin] : TARIFF_PROGRAMS.US;
  const duty = round2(extended * tariff.adValorem);
  return {
    cpn: line.cpn, mpn: line.mpn, manufacturer: part.manufacturer, quantity: line.quantity, unitPrice: line.unitPrice,
    extended, countryOfOrigin: part.countryOfOrigin, tariffProgram: tariff.program, tariffRate: tariff.adValorem, estimatedDuty: duty,
    leadTimeWeeks: part.stock >= line.quantity ? 0 : part.leadTimeWeeks,
  };
}

function quoteNumber() {
  return String(25220000 + Math.floor(Math.random() * 9000));
}

/**
 * Submits a BOM as a request for quote to Sales Workbench: prices every line at its
 * break, estimates import duty for the ship-to country and returns the quote summary.
 */
async function submitQuote(data) {
  const startTime = Date.now();
  const bom = BOMS[data.bomId];
  const requestId = data.requestId || uuidv4();
  const quoteRef = `QR-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Submitting BOM request for quote to Sales Workbench', {
    quoteRef, requestId, bomId: bom.id, lines: bom.lines.length, account: ACCOUNT.number, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 400));

    const lines = bom.lines
      .map((l) => describeLine(l, bom.buildQty))
      .map((l) => quoteLine(l, ACCOUNT.shipToCountry));
    const subtotal = round2(lines.reduce((sum, l) => sum + l.extended, 0));
    const estimatedDuty = round2(lines.reduce((sum, l) => sum + l.estimatedDuty, 0));

    incrementMetric('quote.submit.success', { route: ROUTE });
    recordTiming('quote.submit.latency', Date.now() - startTime, { route: ROUTE });

    return {
      success: true,
      quoteNumber: quoteNumber(),
      quoteRef,
      status: 'Processing',
      bomId: bom.id,
      bomName: bom.name,
      reference: data.quoteReference || bom.name,
      additionalInformation: data.additionalInformation || '',
      account: { name: ACCOUNT.name, number: ACCOUNT.number, terms: ACCOUNT.terms },
      owner: 'MyarrowNA, Prod10',
      partsQuoted: lines.length,
      lines,
      subtotal,
      estimatedDuty,
      total: round2(subtotal + estimatedDuty),
      currency: ACCOUNT.currency,
      submittedAt: new Date().toISOString(),
      expiresInDays: 45,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('quote.submit.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('quote.submit.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('BOM request for quote failed', {
      quoteRef, requestId, bomId: bom.id, account: ACCOUNT.number, error: error.message, errorClass: error.name,
      durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'arrow-com-bom-quote', alert_path: 'instant' },
      extra: { quoteRef, bomId: bom.id, account: ACCOUNT.number, mpns: bom.lines.map((l) => l.mpn) },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/c03fbe3d.js \u2014 quoteLine',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'c03fbe3d',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Arrow.com \u2014 BOM Request for Quote',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'bom', value: bom.id },
        { key: 'bill_to', value: ACCOUNT.number },
        { key: 'ship_to_country', value: ACCOUNT.shipToCountry },
      ],
      extra: { quoteRef, bomId: bom.id, bomName: bom.name, lines: bom.lines.length, countriesOfOrigin: [...new Set(bom.lines.map((l) => PARTS[l.mpn].countryOfOrigin))].join(',') },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.11.2`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Arrow quote error', { error: err.message });
    });

    error.quoteRef = quoteRef;
    throw error;
  }
}

module.exports = {
  submitQuote,
  listBoms,
  getBom,
  quoteLine,
  unitPriceAt,
  orderQuantity,
  BOMS,
  PARTS,
  TARIFF_PROGRAMS,
  ACCOUNT,
};
