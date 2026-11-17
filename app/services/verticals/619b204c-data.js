const CATALOG = [
  { sku: 'XH-CTR-LIC', name: 'CT reconstruction license', unit: 'site license', approvedCountries: ['US', 'IE', 'DE', 'FR', 'JP', 'ES'] },
  { sku: 'XH-MRS-PK', name: 'MR sequence pack', unit: 'scanner pack', approvedCountries: ['US', 'IE', 'DE', 'FR', 'JP', 'ES'] },
  { sku: 'XH-AIT-SUB', name: 'AI triage subscription', unit: '12-month subscription', approvedCountries: ['US', 'IE', 'DE', 'FR', 'ES'] },
  { sku: 'XH-DOSE-SUB', name: 'Dose analytics subscription', unit: '12-month subscription', approvedCountries: ['US', 'IE', 'DE', 'FR', 'JP', 'ES'] },
];

const NETWORK_SITES = [
  'Boston Harbor', 'Cambridge', 'Worcester', 'Springfield', 'Providence', 'Hartford', 'New Haven', 'Stamford',
  'Albany', 'Syracuse', 'Rochester', 'Buffalo', 'Erie', 'Pittsburgh', 'Harrisburg', 'Allentown',
  'Scranton', 'Trenton', 'Newark', 'Paterson', 'Camden', 'Wilmington', 'Dover', 'Baltimore',
  'Annapolis', 'Frederick', 'Hagerstown', 'Richmond', 'Norfolk', 'Roanoke', 'Charlottesville', 'Lynchburg',
  'Raleigh', 'Durham', 'Greensboro', 'Winston-Salem', 'Charlotte', 'Asheville', 'Columbia', 'Greenville',
  'Charleston', 'Savannah', 'Augusta', 'Macon', 'Athens', 'Atlanta Midtown', 'Atlanta North', 'Chattanooga',
];

function siteLines(sku, sites, prefix, quantity) {
  return sites.map((site, i) => ({
    lineNumber: i + 1,
    sku,
    quantity,
    siteId: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    siteName: site,
  }));
}

const ORDERS = [
  {
    orderNumber: 'SO-48207', customer: "St. Brigid's University Hospital", country: 'IE', source: 'LEGACY_EBS', bookedHoursBefore: 13.8,
    billTo: "St. Brigid's University Hospital, Accounts Payable, Dublin 8, IE", deliverTo: 'Radiology IT, Main Campus, Dublin 8, IE',
    lines: siteLines('XH-CTR-LIC', ['Main Campus CT 1', 'Main Campus CT 2'], 'SBUH', 1),
  },
  {
    orderNumber: 'SO-48209', customer: 'Klinikum Rheinhafen', country: 'DE', source: 'LEGACY_EBS', bookedHoursBefore: 12.4,
    billTo: 'Klinikum Rheinhafen gGmbH, Kreditorenbuchhaltung, 68159 Mannheim, DE', deliverTo: 'Institut für Radiologie, Haus C, 68159 Mannheim, DE',
    lines: siteLines('XH-MRS-PK', ['MRT 1 (1.5T)', 'MRT 2 (3T)', 'MRT 3 (3T)', 'MRT Kinderklinik'], 'KRH', 1),
  },
  {
    orderNumber: 'SO-48211', customer: 'Northbridge Health Network', country: 'US', source: 'FUSION_SUBSCRIPTIONS', bookedHoursBefore: 4.2,
    billTo: 'Northbridge Health Network, Supply Chain Finance, Boston MA 02114, US', deliverTo: 'Enterprise Imaging, 48 network sites (one line per site)',
    lines: siteLines('XH-DOSE-SUB', NETWORK_SITES, 'NHN', 1),
  },
  {
    orderNumber: 'SO-48213', customer: 'Centre Hospitalier Val-de-Loire', country: 'FR', source: 'LEGACY_EBS', bookedHoursBefore: 3.9,
    billTo: 'CH Val-de-Loire, Direction des achats, 37000 Tours, FR', deliverTo: "Service d'imagerie médicale, Bâtiment B, 37000 Tours, FR",
    lines: siteLines('XH-CTR-LIC', ['Scanner Urgences', 'Scanner Bâtiment B', 'Scanner Oncologie'], 'CHVL', 1),
  },
  {
    orderNumber: 'SO-48216', customer: 'Kanto Minato Medical Center', country: 'JP', source: 'FUSION_SUBSCRIPTIONS', bookedHoursBefore: 3.4,
    billTo: 'Kanto Minato Medical Center, Procurement, Minato-ku Tokyo 105-0011, JP', deliverTo: 'Department of Radiology, East Wing, Tokyo 105-0011, JP',
    lines: siteLines('XH-AIT-SUB', ['Emergency CT', 'Neuro CT'], 'KMMC', 1),
  },
  {
    orderNumber: 'SO-48218', customer: 'Hospital Universitario Sierra Norte', country: 'ES', source: 'LEGACY_EBS', bookedHoursBefore: 2.9,
    billTo: 'Hospital Universitario Sierra Norte, Compras, 28034 Madrid, ES', deliverTo: 'Servicio de Radiodiagnóstico, Planta 1, 28034 Madrid, ES',
    lines: siteLines('XH-MRS-PK', ['RM 1', 'RM 2', 'RM 3', 'RM Pediatría', 'RM Neurología', 'RM Traumatología'], 'HUSN', 1),
  },
  {
    orderNumber: 'SO-48220', customer: "Lakeview Children's Hospital", country: 'US', source: 'FUSION_SUBSCRIPTIONS', bookedHoursBefore: 2.6,
    billTo: "Lakeview Children's Hospital, Accounts Payable, Chicago IL 60614, US", deliverTo: 'Pediatric Imaging, Tower 2, Chicago IL 60614, US',
    lines: siteLines('XH-AIT-SUB', ['Pediatric ED CT'], 'LCH', 1),
  },
  {
    orderNumber: 'SO-48223', customer: 'Universitätsklinikum Elbtal', country: 'DE', source: 'FUSION_SUBSCRIPTIONS', bookedHoursBefore: 2.1,
    billTo: 'Universitätsklinikum Elbtal AöR, Einkauf, 01307 Dresden, DE', deliverTo: 'Klinik für Radiologie, Haus 19, 01307 Dresden, DE',
    lines: siteLines('XH-DOSE-SUB', ['CT Notaufnahme', 'CT Haus 19', 'CT Kinderradiologie', 'Angiographie', 'PET/CT'], 'UKE', 1),
  },
];

function findOrder(orderNumber) {
  return ORDERS.find((o) => o.orderNumber === orderNumber) || null;
}

module.exports = { CATALOG, ORDERS, findOrder };
