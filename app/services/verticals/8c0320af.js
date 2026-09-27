/**
 * 8c0320af — EV studio checkout: configurator catalog, in-stock inventory,
 * payment programs and the quote engine behind the review screen.
 *
 * Quotes are built here; order placement and quote reconciliation live in
 * ./8c0320af-orders.js.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');

const SERVICE = '8c0320af-api';
const QUOTE_ROUTE = '/api/8c0320af/quotes';

const STUDIO = {
  id: 'STU-KOP',
  name: 'King of Prussia Studio',
  address: '160 N Gulph Rd, King of Prussia, PA 19406',
  state: 'PA',
  deliveryWindow: 'Delivery in 7–10 days',
};

/** Upfront sales tax on leased vehicles by delivery state. */
const TAX_RATES = {
  PA: 0.06,
  MI: 0.06,
  FL: 0.06,
  CA: 0.0725,
  AZ: 0.056,
  TX: 0.0625,
};

const FEES = {
  acquisition: 995,
  documentation: 85,
  destination: 1650,
};

const TRIMS = [
  {
    code: 'pure',
    modelYear: 2026,
    name: 'Air Pure',
    tagline: 'The most efficient production car ever made.',
    basePrice: 70900,
    range: 420,
    power: 430,
    zeroToSixty: '4.5',
    drivetrain: 'Single Motor, Rear-Wheel Drive',
    leaseFrom: 699,
    image: 'https://renderchain.lucidmotors.com/1920x1440/filters:format(.webp)/renderchain/air/2025/pure/CAM_EXT_08/studio/3840-2880/AIR-PURE-STD-L901-SCL0-RF00-EXT01-WH00-INT18-AD01-RENA.png',
  },
  {
    code: 'touring',
    modelYear: 2026,
    name: 'Air Touring',
    tagline: 'Dual-motor performance with an unmatched range-to-power ratio.',
    basePrice: 79900,
    range: 431,
    power: 620,
    zeroToSixty: '3.4',
    drivetrain: 'Dual Motor, All-Wheel Drive',
    leaseFrom: 819,
    image: 'https://renderchain.lucidmotors.com/1280x960/filters:format(.webp)/filters:sharpen(1,0,false)/filters:quality(90)/renderchain/air/2025/touring/CAM_EXT_08/alpha/3840-2880/AIR-AT-STD-L102-SCL0-RF00-EXT02-WH00-INT18-AD01-RENA.png',
  },
  {
    code: 'grand_touring',
    modelYear: 2026,
    name: 'Air Grand Touring',
    tagline: 'The longest range of any electric vehicle on sale today.',
    basePrice: 114900,
    range: 512,
    power: 819,
    zeroToSixty: '3.0',
    drivetrain: 'Dual Motor, All-Wheel Drive',
    leaseFrom: 1199,
    image: 'https://renderchain.lucidmotors.com/1920x1440/filters:format(.webp)/renderchain/air/2025/grand_touring/CAM_EXT_08/studio/3840-2880/AIR-GT-STD-L102-SCL0-RF01-EXT07-WH04-INT02-AD01-RENA.png',
  },
  {
    code: 'sapphire',
    modelYear: 2026,
    name: 'Air Sapphire',
    tagline: 'The world\u2019s first electric super-sports sedan.',
    basePrice: 249000,
    range: 427,
    power: 1234,
    zeroToSixty: '1.89',
    drivetrain: 'Tri Motor, All-Wheel Drive',
    leaseFrom: 2799,
    image: 'https://images.ctfassets.net/5ky6szwjj7ya/lucid-air-sapphire-desktop-02_2x.webp/444a19bec99f32d7092af4e771beb165/lucid-air-sapphire-desktop-02_2x.webp?q=50',
  },
];

const RENDER_BASE = 'https://renderchain.lucidmotors.com/1280x960/filters:format(.webp)/filters:sharpen(1,0,false)/filters:quality(90)/renderchain/air/2025';

function gtRender(spec) {
  return `${RENDER_BASE}/grand_touring/CAM_EXT_08/alpha/3840-2880/AIR-GT-STD-${spec}-RENA.png`;
}

const INVENTORY = [
  {
    vin: '50EA1TGA0S3114871',
    stockNumber: 'KOP-31487',
    trim: 'grand_touring',
    condition: 'New',
    availability: 'Available Now',
    availabilityDays: 0,
    exterior: 'Zenith Red Metallic',
    interior: 'Mojave PurLuxe Leather Alternative',
    wheels: '21\u201d Aero Blade',
    roof: 'Glass Canopy',
    appearance: 'Stealth Appearance',
    driverAssistance: 'DreamDrive\u2122 Pro',
    sound: 'Surreal Sound\u2122 Pro',
    options: [
      { code: 'EXT-ZENITH', label: 'Zenith Red Metallic', price: 1250 },
      { code: 'STEALTH', label: 'Stealth Appearance', price: 1750 },
      { code: 'WH-21-BLADE', label: '21\u201d Aero Blade Wheels', price: 2000 },
    ],
    inventoryDiscount: 5000,
    image: gtRender('L304-SCL0-RF01-EXT07-WH08-INT02-AD02'),
  },
  {
    vin: '50EA1TGA2S3114902',
    stockNumber: 'KOP-31490',
    trim: 'grand_touring',
    condition: 'New',
    availability: 'Available In 2 Weeks',
    availabilityDays: 14,
    exterior: 'Cosmos Silver Metallic',
    interior: 'Tahoe Nappa Leather',
    wheels: '20\u201d Aero Lite',
    roof: 'Glass Canopy',
    appearance: 'Platinum Appearance',
    driverAssistance: 'DreamDrive\u2122 Pro',
    sound: 'Surreal Sound\u2122 Pro',
    options: [
      { code: 'EXT-COSMOS', label: 'Cosmos Silver Metallic', price: 0 },
      { code: 'INT-TAHOE', label: 'Tahoe Nappa Leather', price: 2500 },
    ],
    inventoryDiscount: 0,
    image: gtRender('L203-SCL0-RF00-EXT03-WH01-INT18-AD01'),
  },
  {
    vin: '50EA1TGA6S3115120',
    stockNumber: 'KOP-31512',
    trim: 'grand_touring',
    condition: 'New',
    availability: 'Available In 3+ Weeks',
    availabilityDays: 24,
    exterior: 'Fathom Blue Metallic',
    interior: 'Tahoe Nappa Leather',
    wheels: '19\u201d Aero Range',
    roof: 'Glass Canopy',
    appearance: 'Platinum Appearance',
    driverAssistance: 'DreamDrive\u2122 Premium',
    sound: 'Surreal Sound\u2122 Pro',
    options: [
      { code: 'EXT-FATHOM', label: 'Fathom Blue Metallic', price: 1250 },
      { code: 'INT-TAHOE', label: 'Tahoe Nappa Leather', price: 2500 },
    ],
    inventoryDiscount: 0,
    image: gtRender('L806-SCL0-RF00-EXT03-WH01-INT06-AD01'),
  },
  {
    vin: '50EA1PBA4S3109988',
    stockNumber: 'KOP-30998',
    trim: 'pure',
    condition: 'New',
    availability: 'Available In 2 Weeks',
    availabilityDays: 14,
    exterior: 'Infinite Black Metallic',
    interior: 'Mojave PurLuxe Leather Alternative',
    wheels: '19\u201d Aero Range',
    roof: 'Aluminum Roof',
    appearance: 'Pure Platinum with Aluminum Roof',
    driverAssistance: 'DreamDrive\u2122 Premium',
    sound: 'Surreal Sound\u2122',
    options: [],
    inventoryDiscount: 0,
    image: `${RENDER_BASE}/pure/CAM_EXT_08/alpha/3840-2880/AIR-PURE-STD-L901-SCL0-RF00-EXT01-WH00-INT18-AD01-RENA.png`,
  },
  {
    vin: '50EA1TBA8S3110341',
    stockNumber: 'KOP-31034',
    trim: 'touring',
    condition: 'New',
    availability: 'Available In 2 Weeks',
    availabilityDays: 14,
    exterior: 'Cosmos Silver Metallic',
    interior: 'Santa Cruz PurLuxe Leather Alternative',
    wheels: '19\u201d Aero Range',
    roof: 'Glass Canopy',
    appearance: 'Platinum Appearance',
    driverAssistance: 'DreamDrive\u2122 Premium',
    sound: 'Surreal Sound\u2122 Pro',
    options: [],
    inventoryDiscount: 0,
    image: `${RENDER_BASE}/touring/CAM_EXT_08/alpha/3840-2880/AIR-AT-STD-L102-SCL0-RF00-EXT02-WH00-INT18-AD01-RENA.png`,
  },
];

/**
 * Finance incentives feed. Each offer is keyed by the units it applies to so
 * the quote engine can pick up studio-level programs without touching
 * inventory records.
 */
const OFFERS = [
  {
    code: 'STUDIO_SELECT',
    label: 'Studio Select inventory adjustment',
    amount: 5000,
    taxable: false,
    vins: ['50EA1TGA0S3114871'],
    programs: ['lease', 'finance', 'cash'],
  },
  {
    code: 'LOYALTY',
    label: 'Owner loyalty credit',
    amount: 1000,
    taxable: false,
    requires: 'loyalty',
    programs: ['lease', 'finance'],
  },
  {
    code: 'CONQUEST',
    label: 'Conquest credit',
    amount: 2000,
    taxable: false,
    requires: 'conquest',
    programs: ['lease'],
  },
];

const PROGRAMS = [
  {
    code: 'lease-36-10k',
    type: 'lease',
    label: 'Lease',
    termMonths: 36,
    milesPerYear: 10000,
    capCostReduction: 1000,
    residualPct: 0.58,
    moneyFactor: 0.00109,
    monthlyPayment: { pure: 699, touring: 819, grand_touring: 1199, sapphire: 2799 },
  },
  {
    code: 'finance-72',
    type: 'finance',
    label: 'Finance',
    termMonths: 72,
    apr: 0.0499,
    downPaymentPct: 0.10,
  },
  {
    code: 'cash',
    type: 'cash',
    label: 'Cash',
  },
];

const QUOTES = new Map();
const MAX_QUOTES = 200;

function storeQuote(quoteId, record) {
  QUOTES.delete(quoteId);
  QUOTES.set(quoteId, record);
  while (QUOTES.size > MAX_QUOTES) {
    QUOTES.delete(QUOTES.keys().next().value);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function shortTag(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 0xffff).toString(16).padStart(4, '0');
}

function findTrim(code) {
  return TRIMS.find((t) => t.code === code) || null;
}

function findVehicle(vin) {
  return INVENTORY.find((v) => v.vin === vin) || null;
}

function findProgram(code) {
  return PROGRAMS.find((p) => p.code === code) || null;
}

function resolveVehiclePricing(vehicle, trim) {
  const optionsTotal = vehicle.options.reduce((sum, o) => sum + o.price, 0);
  const listPrice = trim.basePrice + optionsTotal;
  const inventoryDiscount = vehicle.inventoryDiscount || 0;
  return {
    basePrice: trim.basePrice,
    optionsTotal,
    listPrice,
    inventoryDiscount,
    sellingPrice: listPrice - inventoryDiscount,
    destination: FEES.destination,
  };
}

function collectIncentives(vehicle, program, buyer) {
  return OFFERS.filter((offer) => {
    if (!offer.programs.includes(program.type)) return false;
    if (offer.vins && !offer.vins.includes(vehicle.vin)) return false;
    if (offer.requires && !buyer[offer.requires]) return false;
    return true;
  }).map((offer) => ({
    code: offer.code,
    label: offer.label,
    amount: offer.amount,
    taxable: offer.taxable,
  }));
}

function computeUpfrontTax(pricing, incentives, state) {
  const rate = TAX_RATES[state];
  if (rate === undefined) {
    throw new Error(`No tax schedule for delivery state ${state}`);
  }
  const nonTaxable = incentives
    .filter((i) => !i.taxable)
    .reduce((sum, i) => sum + i.amount, 0);
  const base = round2(pricing.sellingPrice - nonTaxable);
  return { rate, base, amount: round2(base * rate) };
}

function computeLeaseTerms(pricing, program, trim) {
  const capitalizedCost = pricing.sellingPrice + FEES.acquisition - program.capCostReduction;
  const residualValue = round2(trim.basePrice * program.residualPct);
  return {
    termMonths: program.termMonths,
    milesPerYear: program.milesPerYear,
    capitalizedCost,
    capCostReduction: program.capCostReduction,
    residualValue,
    moneyFactor: program.moneyFactor,
    monthlyPayment: program.monthlyPayment[trim.code],
  };
}

function computeFinanceTerms(pricing, program) {
  const downPayment = round2(pricing.sellingPrice * program.downPaymentPct);
  const principal = pricing.sellingPrice + pricing.destination - downPayment;
  const r = program.apr / 12;
  const n = program.termMonths;
  const monthlyPayment = round2((principal * r) / (1 - (1 + r) ** -n));
  return {
    termMonths: n,
    apr: program.apr,
    downPayment,
    principal,
    monthlyPayment,
  };
}

function computeDueAtDelivery(program, terms, tax) {
  if (program.type === 'lease') {
    return round2(
      terms.capCostReduction
        + terms.monthlyPayment
        + FEES.acquisition
        + FEES.documentation
        + tax.amount,
    );
  }
  if (program.type === 'finance') {
    return round2(terms.downPayment + FEES.documentation + tax.amount);
  }
  return round2(terms.total + FEES.documentation + tax.amount);
}

function buildPaymentOptions(vehicle, trim) {
  const pricing = resolveVehiclePricing(vehicle, trim);
  return PROGRAMS.map((program) => {
    if (program.type === 'lease') {
      const lease = computeLeaseTerms(pricing, program, trim);
      return {
        code: program.code,
        type: program.type,
        label: program.label,
        headline: `$${lease.monthlyPayment.toLocaleString('en-US')}/mo`,
        detail: `${program.termMonths} months \u00b7 ${(program.milesPerYear / 1000)}k mi/yr \u00b7 $${lease.capCostReduction.toLocaleString('en-US')} down`,
      };
    }
    if (program.type === 'finance') {
      const finance = computeFinanceTerms(pricing, program);
      return {
        code: program.code,
        type: program.type,
        label: program.label,
        headline: `$${Math.round(finance.monthlyPayment).toLocaleString('en-US')}/mo`,
        detail: `${program.termMonths} months \u00b7 ${(program.apr * 100).toFixed(2)}% APR \u00b7 $${finance.downPayment.toLocaleString('en-US')} down`,
      };
    }
    return {
      code: program.code,
      type: program.type,
      label: program.label,
      headline: `$${pricing.sellingPrice.toLocaleString('en-US')}`,
      detail: 'Plus destination, taxes and fees',
    };
  });
}

function formatQuote({
  quoteId, vehicle, trim, program, pricing, incentives, terms, tax, amountDueAtDelivery, requestId,
}) {
  const lines = [];
  if (program.type === 'lease') {
    lines.push({ label: 'Capitalized cost reduction', amount: terms.capCostReduction });
    lines.push({ label: 'First month\u2019s payment', amount: terms.monthlyPayment });
    lines.push({ label: 'Acquisition fee', amount: FEES.acquisition });
    lines.push({ label: 'Documentation fee', amount: FEES.documentation });
  } else if (program.type === 'finance') {
    lines.push({ label: 'Down payment', amount: terms.downPayment });
    lines.push({ label: 'Documentation fee', amount: FEES.documentation });
  } else {
    lines.push({ label: 'Vehicle price', amount: terms.total });
    lines.push({ label: 'Documentation fee', amount: FEES.documentation });
  }
  lines.push({ label: `Estimated taxes (${(tax.rate * 100).toFixed(2)}%)`, amount: tax.amount });

  return {
    quoteId,
    requestId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    studio: STUDIO,
    vehicle: {
      vin: vehicle.vin,
      stockNumber: vehicle.stockNumber,
      modelYear: trim.modelYear,
      trim: trim.code,
      trimName: trim.name,
      exterior: vehicle.exterior,
      interior: vehicle.interior,
      wheels: vehicle.wheels,
      availability: vehicle.availability,
      image: vehicle.image,
    },
    program: { code: program.code, type: program.type, label: program.label },
    pricing,
    incentives,
    terms,
    tax,
    lines,
    amountDueAtDelivery,
  };
}

/**
 * Build a payment quote for a specific in-stock unit and payment program.
 * The quote is stored server-side so order placement can reconcile against it.
 */
async function createQuote(data) {
  const requestId = uuidv4();
  const startTime = Date.now();

  const vehicle = findVehicle(data.vin);
  if (!vehicle) {
    const err = new Error(`Unknown vehicle ${data.vin}`);
    err.status = 404;
    err.code = 'VEHICLE_NOT_FOUND';
    throw err;
  }
  const trim = findTrim(vehicle.trim);
  const program = findProgram(data.program);
  if (!program) {
    const err = new Error(`Unknown payment program ${data.program}`);
    err.status = 400;
    err.code = 'PROGRAM_NOT_FOUND';
    throw err;
  }
  const buyer = { loyalty: !!data.loyalty, conquest: !!data.conquest };
  const state = data.deliveryState || STUDIO.state;

  logger.info('Building payment quote', {
    requestId, vin: vehicle.vin, trim: trim.code, program: program.code, state, service: SERVICE, route: QUOTE_ROUTE,
  });

  await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

  const pricing = resolveVehiclePricing(vehicle, trim);
  const incentives = collectIncentives(vehicle, program, buyer);
  const tax = computeUpfrontTax(pricing, incentives, state);

  let terms;
  if (program.type === 'lease') {
    terms = computeLeaseTerms(pricing, program, trim);
  } else if (program.type === 'finance') {
    terms = computeFinanceTerms(pricing, program);
  } else {
    terms = { total: pricing.sellingPrice + pricing.destination };
  }

  const amountDueAtDelivery = computeDueAtDelivery(program, terms, tax);
  const quoteId = `q_${shortTag(`${vehicle.vin}:${program.code}`)}`;

  const quote = formatQuote({
    quoteId, vehicle, trim, program, pricing, incentives, terms, tax, amountDueAtDelivery, requestId,
  });
  storeQuote(quoteId, { ...quote, state });

  const duration = Date.now() - startTime;
  incrementMetric('ev_checkout.quote.success', { route: QUOTE_ROUTE, program: program.code, trim: trim.code });
  recordTiming('ev_checkout.quote.latency', duration, { route: QUOTE_ROUTE });
  logger.info('Payment quote issued', {
    requestId, quoteId, vin: vehicle.vin, program: program.code, amountDueAtDelivery, durationMs: duration, service: SERVICE,
  });

  return quote;
}

function getQuote(quoteId) {
  return QUOTES.get(quoteId) || null;
}

function clearQuotes() {
  const cleared = QUOTES.size;
  QUOTES.clear();
  return cleared;
}

module.exports = {
  SERVICE,
  STUDIO,
  TRIMS,
  INVENTORY,
  OFFERS,
  PROGRAMS,
  FEES,
  TAX_RATES,
  findTrim,
  findVehicle,
  findProgram,
  resolveVehiclePricing,
  collectIncentives,
  computeUpfrontTax,
  computeLeaseTerms,
  computeFinanceTerms,
  computeDueAtDelivery,
  buildPaymentOptions,
  createQuote,
  getQuote,
  clearQuotes,
};
