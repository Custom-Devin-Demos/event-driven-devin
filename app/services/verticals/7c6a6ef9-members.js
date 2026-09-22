/**
 * Member records, plan configuration and service catalog for the Highmark
 * enGen member coverage vertical (7c6a6ef9).
 *
 * Cost sharing is governed per member by the plan the member is enrolled in.
 * The 2026 benefit-year renewal moved plan assignment off the member profile
 * and under `enrollment`, so the plan, group number and effective date travel
 * together and a member can carry a pending renewal alongside the active plan.
 */
const PLAN_CONFIG = {
  ppo: { name: 'Highmark my Priority Blue Flex PPO', deductible: 2000, oopMax: 6000, copay: 30, coinsurance: 0.20 },
  hmo: { name: 'Highmark Together Blue HMO', deductible: 1500, oopMax: 5000, copay: 20, coinsurance: 0.15 },
  epo: { name: 'Highmark Community Blue EPO', deductible: 1750, oopMax: 5500, copay: 25, coinsurance: 0.18 },
  hdhp: { name: 'Highmark Health Savings Blue HDHP', deductible: 3500, oopMax: 7000, copay: 0, coinsurance: 0.10 },
};

const MEMBERS = [
  {
    id: 'HM-20481973',
    email: 'sarah.johnson@example.com',
    name: 'Sarah Johnson',
    dateOfBirth: '1984-06-12',
    enrollment: { planType: 'ppo', groupNumber: 'HMK-114820', effectiveDate: '2026-01-01' },
    accumulators: { deductibleMet: 1240.00, oopMet: 1840.00, claimsYTD: 4 },
  },
  {
    id: 'HM-20559841',
    email: 'david.kim@example.com',
    name: 'David Kim',
    dateOfBirth: '1979-11-03',
    enrollment: { planType: 'hmo', groupNumber: 'HMK-220417', effectiveDate: '2026-01-01' },
    accumulators: { deductibleMet: 950.00, oopMet: 1310.00, claimsYTD: 7 },
  },
  {
    id: 'HM-20612308',
    email: 'maria.garcia@example.com',
    name: 'Maria Garcia',
    dateOfBirth: '1991-02-27',
    enrollment: { planType: 'epo', groupNumber: 'HMK-305592', effectiveDate: '2026-01-01' },
    accumulators: { deductibleMet: 1750.00, oopMet: 2420.00, claimsYTD: 12 },
  },
  {
    id: 'HM-20487562',
    email: 'james.wilson@example.com',
    name: 'James Wilson',
    dateOfBirth: '1968-09-19',
    enrollment: { planType: 'hdhp', groupNumber: 'HMK-114820', effectiveDate: '2026-01-01' },
    accumulators: { deductibleMet: 2100.00, oopMet: 2100.00, claimsYTD: 3 },
  },
];

/**
 * In-network services a member can price before a visit. Allowed amounts are
 * the negotiated rates the plan adjudicates against.
 */
const SERVICES = [
  { id: 'preventive-visit', label: 'Annual wellness exam', allowedAmount: 210, preventive: true, copayApplies: false },
  { id: 'primary-care', label: 'Primary care office visit', allowedAmount: 185, preventive: false, copayApplies: true },
  { id: 'specialist', label: 'Specialist office visit', allowedAmount: 320, preventive: false, copayApplies: true },
  { id: 'urgent-care', label: 'Urgent care visit', allowedAmount: 240, preventive: false, copayApplies: true },
  { id: 'mri', label: 'MRI (outpatient imaging)', allowedAmount: 1450, preventive: false, copayApplies: false },
];

const RECENT_CLAIMS = [
  { date: '2026-04-18', provider: 'Allegheny Health Network - Wexford', service: 'Annual Wellness Exam', amount: 0.00, status: 'Covered' },
  { date: '2026-04-02', provider: 'Highmark Pharmacy Network', service: 'Prescription - Atorvastatin 20mg', amount: 12.00, status: 'Processed' },
  { date: '2026-03-15', provider: 'AHN Primary Care - Pittsburgh', service: 'Primary Care Visit', amount: 30.00, status: 'Processed' },
  { date: '2026-02-28', provider: 'Highmark Pharmacy Network', service: 'Prescription - Metformin 500mg', amount: 8.00, status: 'Processed' },
];

function findMember(query) {
  const email = (query.email || '').trim().toLowerCase();
  const memberId = (query.memberId || '').trim().toUpperCase();
  if (!email && !memberId) return null;
  return MEMBERS.find((m) => (!email || m.email === email) && (!memberId || m.id === memberId)) || null;
}

function findService(serviceId) {
  return SERVICES.find((s) => s.id === serviceId) || null;
}

module.exports = {
  PLAN_CONFIG,
  MEMBERS,
  SERVICES,
  RECENT_CLAIMS,
  findMember,
  findService,
};
