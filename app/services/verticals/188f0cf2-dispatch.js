const STOPS = [
  { id: 'ST-77412', siteId: 'NH-001', date: '2026-11-17', service: 'Front-load 8 yd', status: 'EXCEPTION', exception: { type: 'BLOCKED', reason: null }, source: 'driver-tablet', route: 'C-118' },
  { id: 'ST-77413', siteId: 'NH-001', date: '2026-11-17', service: 'Recycling 6 yd', status: 'COMPLETED', exception: null, source: 'driver-tablet', route: 'C-118' },
  { id: 'ST-77420', siteId: 'NH-004', date: '2026-11-17', service: 'Front-load 8 yd', status: 'COMPLETED', exception: null, source: 'driver-tablet', route: 'C-121' },
  { id: 'ST-77391', siteId: 'NH-002', date: '2026-11-16', service: 'Compactor 30 yd', status: 'COMPLETED', exception: null, source: 'driver-tablet', route: 'RO-07' },
];

const CONTRACT_CREDIT = { 'Front-load 8 yd': 185, 'Recycling 6 yd': 120, 'Compactor 30 yd': 640 };

async function lookupStop(siteId, date, service) {
  return STOPS.find(stop => stop.siteId === siteId && stop.date === date && stop.service === service);
}

function assessEligibility(stop) {
  if (stop.status === 'COMPLETED') return { eligible: true, credit: CONTRACT_CREDIT[stop.service], evidence: stop.id };
  const code = stop.exception.reason.code;
  return { eligible: code !== 'CUSTOMER_BLOCKED', credit: code === 'ROUTE_MISSED' ? CONTRACT_CREDIT[stop.service] : 0, evidence: stop.id };
}

function formatClaim(requestId, assessment) {
  return { requestId, status: assessment.eligible ? 'Recovery pickup scheduled within 24 hours' : 'Not eligible for recovery pickup', serviceCredit: assessment.credit, stopId: assessment.evidence };
}

module.exports = { lookupStop, assessEligibility, formatClaim };
