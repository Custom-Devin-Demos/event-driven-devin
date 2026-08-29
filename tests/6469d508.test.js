const {
  submitAppointmentInquiry,
  buildCalendarLane,
  reserveVisitSlot,
  VISIT_TYPES,
  SCHEDULING_WINDOWS,
} = require('../app/services/verticals/6469d508');

describe('Health system appointment inquiry service (6469d508)', () => {
  test('reserves a primary care slot instead of throwing on the scheduling window', async () => {
    const result = await submitAppointmentInquiry({ visitType: 'primary_care', zipCode: '10029' });

    expect(result.referenceNumber).toMatch(/^MS-/);
    expect(result.status).toBe('received');
    expect(result.visitCode).toBe('primary_care');
    expect(result.coordinationDesk).toBe(SCHEDULING_WINDOWS['mshs-primary-care'].desk);
    expect(Number.isNaN(Date.parse(result.firstAvailableAt))).toBe(false);
  });

  test.each(Object.keys(VISIT_TYPES))('reserves a slot for visit type %s', async (code) => {
    const result = await submitAppointmentInquiry({ visitType: code, zipCode: '10029' });

    expect(result.visitCode).toBe(code);
    expect(Number.isNaN(Date.parse(result.firstAvailableAt))).toBe(false);
  });

  test('every visit type maps to a configured scheduling window', () => {
    for (const visitType of Object.values(VISIT_TYPES)) {
      expect(SCHEDULING_WINDOWS[buildCalendarLane(visitType)]).toBeDefined();
    }
  });

  test('throws a labelled error when a lane has no scheduling window', () => {
    const visitType = VISIT_TYPES.primary_care;

    expect(() => reserveVisitSlot({ lane: 'mshs-concierge-care' }, visitType)).toThrow(
      /No scheduling window configured/,
    );

    try {
      reserveVisitSlot({ lane: 'mshs-concierge-care' }, visitType);
    } catch (error) {
      expect(error.code).toBe('SCHEDULING_WINDOW_NOT_FOUND');
      expect(error.name).not.toBe('TypeError');
    }
  });

  test('falls back to primary care for an unknown visit type', async () => {
    const result = await submitAppointmentInquiry({ visitType: 'does-not-exist' });

    expect(result.visitCode).toBe('primary_care');
  });
});
