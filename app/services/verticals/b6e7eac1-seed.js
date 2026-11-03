/**
 * Reference data for the rental-return integration demo (slug b6e7eac1).
 *
 * In the customer's estate the dealer directory and the branch→warehouse map
 * live in configuration; here they are code so the service is self-contained.
 * Every reset reloads this file's data and re-runs STUCK_RETURN_EVENTS through
 * the real pipeline, so the dead-letter reasons are produced, not hard-coded.
 */

const SEED_NOW = '2026-11-02T20:30:00.000Z';

/** Dealer code on the inbound event → legal entity (dataAreaId) in the ERP. */
const DEALERS = [
  { dealerCode: 'EMPIRE', dataAreaId: 'emp', name: 'Empire Cat', country: 'US' },
  { dealerCode: 'ALTORF', dataAreaId: 'alt', name: 'Altorfer Cat', country: 'US' },
  { dealerCode: 'FINNING', dataAreaId: 'fin', name: 'Finning Canada', country: 'CA' },
];

/** Return yard (branch) → ERP warehouse, per legal entity. */
const WAREHOUSE_MAP = {
  emp: {
    'PHX-01': 'EMP-PHX-01',
    'MESA-01': 'EMP-MESA-01',
    'TUC-01': 'EMP-TUC-01',
    'FLG-01': 'EMP-FLG-01',
  },
  alt: {
    'PEO-01': 'ALT-PEO-01',
    'CHI-01': 'ALT-CHI-01',
    'SPI-01': 'ALT-SPI-01',
  },
  fin: {
    'EDM-01': 'FIN-EDM-01',
    'CGY-01': 'FIN-CGY-01',
    'VAN-01': 'FIN-VAN-01',
    'FSJ-01': 'FIN-FSJ-01',
  },
};

function daysAgo(days) {
  return new Date(Date.parse(SEED_NOW) - days * 86400000).toISOString();
}

function hoursAgo(hours) {
  return new Date(Date.parse(SEED_NOW) - hours * 3600000).toISOString();
}

/** RentalContractLines (simplified) for the three legal entities. */
const CONTRACT_LINES = [
  { dataAreaId: 'emp', contractId: 'RC-EMP-100232', customerName: 'Sundt Construction', model: '320 GC Hydraulic Excavator', serialNumber: 'CAT0320GCXKJ00912', state: 'OnRent', deliveryWarehouseId: 'EMP-PHX-01', rentalStart: daysAgo(23) },
  { dataAreaId: 'emp', contractId: 'RC-EMP-100219', customerName: 'Pulice Construction', model: 'D6 XE Dozer', serialNumber: 'CAT00D6XEAG400377', state: 'OnRent', deliveryWarehouseId: 'EMP-MESA-01', rentalStart: daysAgo(11) },
  { dataAreaId: 'emp', contractId: 'RC-EMP-100198', customerName: 'Haydon Building Corp', model: '950 GC Wheel Loader', serialNumber: 'CAT0950GCCM700215', state: 'Returned', deliveryWarehouseId: 'EMP-TUC-01', rentalStart: daysAgo(40), returnWarehouseId: 'EMP-TUC-01', returnHoursMeter: 1412, returnFuelPercent: 65, returnedAt: daysAgo(3) },
  { dataAreaId: 'emp', contractId: 'RC-EMP-100105', customerName: 'Kiewit Southwest', model: '336 Hydraulic Excavator', serialNumber: 'CAT00336KDFW10088', state: 'Invoiced', deliveryWarehouseId: 'EMP-PHX-01', rentalStart: daysAgo(75), returnWarehouseId: 'EMP-PHX-01', returnHoursMeter: 3980, returnFuelPercent: 80, returnedAt: daysAgo(31) },
  { dataAreaId: 'alt', contractId: 'RC-ALT-200411', customerName: 'Williams Brothers Construction', model: '140 Motor Grader', serialNumber: 'CAT00140AEB800641', state: 'OnRent', deliveryWarehouseId: 'ALT-PEO-01', rentalStart: daysAgo(17) },
  { dataAreaId: 'alt', contractId: 'RC-ALT-200377', customerName: 'Walsh Construction', model: '259D3 Compact Track Loader', serialNumber: 'CAT259D3HCW600209', state: 'Invoiced', deliveryWarehouseId: 'ALT-CHI-01', rentalStart: daysAgo(60), returnWarehouseId: 'ALT-CHI-01', returnHoursMeter: 611, returnFuelPercent: 90, returnedAt: daysAgo(28) },
  { dataAreaId: 'fin', contractId: 'RC-FIN-300077', customerName: 'Suncor Energy', model: '745 Articulated Truck', serialNumber: 'CAT00745A3T600114', state: 'OnRent', deliveryWarehouseId: 'FIN-EDM-01', rentalStart: daysAgo(34) },
  { dataAreaId: 'fin', contractId: 'RC-FIN-300069', customerName: 'Ledcor Group', model: 'D8 Dozer', serialNumber: 'CAT000D8TMB300552', state: 'OnRent', deliveryWarehouseId: 'FIN-CGY-01', rentalStart: daysAgo(9) },
  { dataAreaId: 'fin', contractId: 'RC-FIN-300051', customerName: 'Teck Resources', model: '988K Wheel Loader', serialNumber: 'CAT0988KALNW00831', state: 'Returned', deliveryWarehouseId: 'FIN-VAN-01', rentalStart: daysAgo(52), returnWarehouseId: 'FIN-VAN-01', returnHoursMeter: 2205, returnFuelPercent: 70, returnedAt: daysAgo(5) },
  { dataAreaId: 'fin', contractId: 'RC-FIN-300012', customerName: 'PCL Construction', model: '320 Hydraulic Excavator', serialNumber: 'CAT00320KHEX02177', state: 'Invoiced', deliveryWarehouseId: 'FIN-EDM-01', rentalStart: daysAgo(90), returnWarehouseId: 'FIN-EDM-01', returnHoursMeter: 1870, returnFuelPercent: 55, returnedAt: daysAgo(44) },
];

/** Return events currently parked on the dead-letter queue (re-processed on every reset). */
const STUCK_RETURN_EVENTS = [
  { eventId: 'evt-5b21e0aa', dealerCode: 'EMPIRE', contractId: 'RC-EMP-100232', serialNumber: 'CAT0320GCXKJ00912', returnYard: 'PHX-02', hoursMeter: 1886, fuelPercent: 70, returnedAt: hoursAgo(19), source: 'catrentals' },
  { eventId: 'evt-9c04d1f2', dealerCode: 'FINNING-CA', contractId: 'RC-FIN-300077', serialNumber: 'CAT00745A3T600114', returnYard: 'EDM-01', hoursMeter: 4102, fuelPercent: 110, returnedAt: hoursAgo(14), source: 'catrentals' },
];

module.exports = { SEED_NOW, DEALERS, WAREHOUSE_MAP, CONTRACT_LINES, STUCK_RETURN_EVENTS };
