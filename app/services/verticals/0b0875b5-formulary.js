const FORMULARY = [
  {
    ndc: '49281-426-50',
    product: 'Fluzone Trivalent',
    manufacturer: 'Sanofi Pasteur',
    formulation: 'IIV3-SD',
    presentation: '0.5 mL prefilled syringe, 10 per carton',
    minAgeMonths: 6,
    cashPrice: 99.0,
    lots: [
      { lotNumber: 'UT8421CA', expiresOn: '2027-06-30', dosesReleased: 1200 },
      { lotNumber: 'UT8433AB', expiresOn: '2027-06-30', dosesReleased: 900 },
    ],
  },
  {
    ndc: '19515-816-52',
    product: 'Flulaval Trivalent',
    manufacturer: 'GSK',
    formulation: 'IIV3-SD',
    presentation: '0.5 mL prefilled syringe, 10 per carton',
    minAgeMonths: 6,
    cashPrice: 99.0,
    lots: [
      { lotNumber: 'F7K2P', expiresOn: '2027-06-30', dosesReleased: 640 },
    ],
  },
  {
    ndc: '49281-126-65',
    product: 'Fluzone High-Dose Trivalent',
    manufacturer: 'Sanofi Pasteur',
    formulation: 'HD-IIV3',
    presentation: '0.5 mL prefilled syringe, 10 per carton',
    minAgeMonths: 780,
    cashPrice: 144.0,
    lots: [
      { lotNumber: 'UJ1190AA', expiresOn: '2027-06-30', dosesReleased: 480 },
    ],
  },
  {
    ndc: '70461-025-03',
    product: 'Fluad Trivalent',
    manufacturer: 'CSL Seqirus',
    formulation: 'aIIV3',
    presentation: '0.5 mL prefilled syringe, 10 per carton',
    minAgeMonths: 780,
    cashPrice: 144.0,
    lots: [
      { lotNumber: '402217', expiresOn: '2027-06-30', dosesReleased: 360 },
    ],
  },
  {
    ndc: '42874-126-10',
    product: 'Flublok Trivalent',
    manufacturer: 'Sanofi Pasteur',
    formulation: 'RIV3',
    presentation: '0.5 mL prefilled syringe, 10 per carton',
    minAgeMonths: 216,
    cashPrice: 144.0,
    lots: [
      { lotNumber: 'VA3310', expiresOn: '2027-05-31', dosesReleased: 300 },
    ],
  },
];

function indexLotsByNdc(products) {
  const index = new Map();
  for (const item of products) {
    const [lot] = item.lots
      .filter((entry) => entry.dosesReleased > 0)
      .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
    index.set(item.ndc, { ...lot, product: item.product, manufacturer: item.manufacturer, cashPrice: item.cashPrice });
  }
  return index;
}

function findLot(index, ndc) {
  return index.get(ndc);
}

module.exports = { FORMULARY, indexLotsByNdc, findLot };
