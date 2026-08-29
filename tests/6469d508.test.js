const {
  submitAppointmentInquiry,
  buildCalendarLane,
  reserveVisitSlot,
  VISIT_TYPES,
  SCHEDULING_WINDOWS,
  DEFAULT_LANE,
} = require('../app/services/verticals/6469d508');

describe('Health system appointment inquiry service (6469d508)', () => {
  test('builds a lane key that exists in the scheduling windows table', () => {
    Object.values(VISIT_TYPES).forEach((visitType) => {
      const lane = buildCalendarLane(visitType);
      expect(SCHEDULING_WINDOWS[lane]).toBeDefined();
    });
  });

  test('reserves a slot for a primary care inquiry', async () => {
    const result = await submitAppointmentInquiry({
      visitType: 'primary_care',
      zipCode: '10029',
    });

    expect(result.referenceNumber).toMatch(/^MS-/);
    expect(result.status).toBe('received');
    expect(result.visitName).toBe('Primary Care Visit');
    expect(result.durationMinutes).toBe(30);
    expect(result.coordinationDesk).toBe('ambulatory-access-center');
    expect(new Date(result.firstAvailableAt).getTime()).toBeGreaterThan(Date.now());
  });

  test.each(Object.keys(VISIT_TYPES))('reserves a slot for visit type %s', async (code) => {
    const result = await submitAppointmentInquiry({ visitType: code, zipCode: '10029' });
    const window = SCHEDULING_WINDOWS[buildCalendarLane(VISIT_TYPES[code])];

    expect(result.visitCode).toBe(code);
    expect(result.coordinationDesk).toBe(window.desk);
    expect(Number.isNaN(new Date(result.firstAvailableAt).getTime())).toBe(false);
  });

  test('falls back to primary care for an unknown visit type', async () => {
    const result = await submitAppointmentInquiry({ visitType: 'does-not-exist' });

    expect(result.visitCode).toBe('primary_care');
    expect(result.coordinationDesk).toBe('ambulatory-access-center');
  });

  test('falls back to the default lane when the lane has no scheduling window', () => {
    const slot = reserveVisitSlot({ lane: 'mshs-unmapped-lane' }, VISIT_TYPES.primary_care);

    expect(slot.coordinationDesk).toBe(SCHEDULING_WINDOWS[DEFAULT_LANE].desk);
    expect(slot.horizonDays).toBe(SCHEDULING_WINDOWS[DEFAULT_LANE].horizonDays);
    expect(Number.isNaN(new Date(slot.firstAvailableAt).getTime())).toBe(false);
  });
});
