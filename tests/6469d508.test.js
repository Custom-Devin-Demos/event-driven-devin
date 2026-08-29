const {
  submitAppointmentInquiry,
  buildCalendarLane,
  reserveVisitSlot,
  VISIT_TYPES,
  SCHEDULING_WINDOWS,
} = require('../app/services/verticals/6469d508');

describe('Health system appointment inquiry service (6469d508)', () => {
  test('reserves a primary care slot instead of throwing on the scheduling window lookup', async () => {
    const result = await submitAppointmentInquiry({
      visitType: 'primary_care',
      zipCode: '10029',
    });

    expect(result.referenceNumber).toMatch(/^MS-/);
    expect(result.visitCode).toBe('primary_care');
    expect(result.visitName).toBe('Primary Care Visit');
    expect(result.coordinationDesk).toBe(SCHEDULING_WINDOWS['mshs-primary-care'].desk);
    expect(Date.parse(result.firstAvailableAt)).not.toBeNaN();
    expect(result.confirmationCallQueued).toBe(true);
  });

  test.each(Object.keys(VISIT_TYPES))('resolves a scheduling window for %s', (code) => {
    const lane = buildCalendarLane(VISIT_TYPES[code]);

    expect(SCHEDULING_WINDOWS[lane]).toBeDefined();
  });

  test('builds hyphenated calendar lanes matching the scheduling window keys', () => {
    expect(buildCalendarLane(VISIT_TYPES.primary_care)).toBe('mshs-primary-care');
    expect(buildCalendarLane(VISIT_TYPES.telehealth)).toBe('mshs-telehealth');
  });

  test('falls back to primary care for an unknown visit type', async () => {
    const result = await submitAppointmentInquiry({ visitType: 'does-not-exist' });

    expect(result.visitCode).toBe('primary_care');
    expect(result.coordinationDesk).toBe(SCHEDULING_WINDOWS['mshs-primary-care'].desk);
  });

  test('throws an explicit error when a lane has no configured scheduling window', () => {
    expect(() => reserveVisitSlot({ lane: 'mshs-unknown-lane' }, VISIT_TYPES.primary_care)).toThrow(
      /No scheduling window configured for calendar lane "mshs-unknown-lane"/,
    );
  });
});
