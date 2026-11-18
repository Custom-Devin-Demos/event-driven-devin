const STOPS = [
  { id: 'ST-4812', addressId: 'ADDR-1048', date: '2026-11-17', container: 'Recycling', status: 'EXCEPTION', exception: { type: 'NOT_OUT', reason: null }, source: 'driver-tablet', route: 'R-214' },
  { id: 'ST-4811', addressId: 'ADDR-1048', date: '2026-11-17', container: 'Trash', status: 'COMPLETED', exception: null, source: 'driver-tablet', route: 'R-214' },
  { id: 'ST-4704', addressId: 'ADDR-1048', date: '2026-11-16', container: 'Yard waste', status: 'COMPLETED', exception: null, source: 'driver-tablet', route: 'R-208' },
];

async function lookupStop(addressId, date, container) {
  return STOPS.find(stop => stop.addressId === addressId && stop.date === date && stop.container === container);
}

function assessEligibility(stop) {
  if (stop.status === 'COMPLETED') return { eligible: true, credit: 6.25, evidence: stop.id };
  const code = stop.exception.reason.code;
  return { eligible: code !== 'CUSTOMER_NOT_OUT', credit: code === 'ROUTE_MISSED' ? 6.25 : 0, evidence: stop.id };
}

function formatClaim(requestId, assessment) {
  return { requestId, status: assessment.eligible ? 'Return pickup requested' : 'Not eligible for return pickup', serviceCredit: assessment.credit, stopId: assessment.evidence };
}

module.exports = { lookupStop, assessEligibility, formatClaim };
