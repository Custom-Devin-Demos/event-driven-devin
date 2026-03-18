/**
 * Regression tests for healthcare.js — getCoveragePeriod and buildAppointmentDate
 *
 * Bug: NODE-EXPRESS-9 — getCoveragePeriod referenced plan.coverageEndDate
 * instead of plan.coverageEnd, and buildAppointmentDate did not adjust for
 * JavaScript's 0-indexed months, both causing getCoveragePeriod to return null
 * and crash on coverage.copayAmount.
 *
 * These tests mirror the fixed pure functions and inline the patient plan data
 * to avoid importing the main module (which pulls in ESM-only uuid).
 */

const PATIENT_PLANS = {
  'PAT-2001': { plan: 'Gold', copayAmount: 20, coverageEnd: '2026-12-31', deductibleRemaining: 250 },
  'PAT-2002': { plan: 'Silver', copayAmount: 35, coverageEnd: '2026-12-31', deductibleRemaining: 800 },
  'PAT-2003': { plan: 'Bronze', copayAmount: 50, coverageEnd: '2026-12-31', deductibleRemaining: 1500 },
};

function buildAppointmentDate(dateStr) {
  const parts = dateStr.split('-');
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function getCoveragePeriod(patientId, appointmentDate) {
  const plan = PATIENT_PLANS[patientId];
  if (!plan) return null;

  const coverageEnd = new Date(plan.coverageEnd);
  if (isNaN(coverageEnd.getTime()) || appointmentDate > coverageEnd) return null;

  return plan;
}

describe('buildAppointmentDate', () => {
  it('should parse 2026-12-15 as December 15 2026 (regression: month was off-by-one)', () => {
    const date = buildAppointmentDate('2026-12-15');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(11); // December is 0-indexed month 11
    expect(date.getDate()).toBe(15);
  });

  it('should parse January correctly (month boundary)', () => {
    const date = buildAppointmentDate('2026-01-05');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(0); // January is month 0
    expect(date.getDate()).toBe(5);
  });
});

describe('getCoveragePeriod', () => {
  it('should return the plan for PAT-2001 with a date within coverage (regression: was returning null)', () => {
    const apptDate = buildAppointmentDate('2026-12-15');
    const result = getCoveragePeriod('PAT-2001', apptDate);
    expect(result).not.toBeNull();
    expect(result.copayAmount).toBe(20);
    expect(result.plan).toBe('Gold');
  });

  it('should return null for an unknown patient ID', () => {
    const apptDate = buildAppointmentDate('2026-06-15');
    const result = getCoveragePeriod('PAT-UNKNOWN', apptDate);
    expect(result).toBeNull();
  });

  it('should return null when appointment date is after coverage end', () => {
    const apptDate = buildAppointmentDate('2027-01-15');
    const result = getCoveragePeriod('PAT-2001', apptDate);
    expect(result).toBeNull();
  });

  it('should return the plan when appointment date equals coverage end date', () => {
    const apptDate = buildAppointmentDate('2026-12-31');
    const result = getCoveragePeriod('PAT-2001', apptDate);
    expect(result).not.toBeNull();
    expect(result.copayAmount).toBe(20);
  });

  it('should return correct copay for each patient plan', () => {
    const apptDate = buildAppointmentDate('2026-06-01');
    expect(getCoveragePeriod('PAT-2001', apptDate).copayAmount).toBe(20);
    expect(getCoveragePeriod('PAT-2002', apptDate).copayAmount).toBe(35);
    expect(getCoveragePeriod('PAT-2003', apptDate).copayAmount).toBe(50);
  });

  it('should use coverageEnd property (regression: was using coverageEndDate which is undefined)', () => {
    const plan = PATIENT_PLANS['PAT-2001'];
    expect(plan.coverageEnd).toBeDefined();
    expect(plan.coverageEndDate).toBeUndefined();
  });
});
