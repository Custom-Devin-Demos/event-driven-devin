const {
  registerForClass,
  CLASS_CATALOG,
  DELIVERY_FORMATS,
} = require('../app/services/verticals/dae1efec');

function daysFromNow(isoString) {
  return Math.round((new Date(isoString).getTime() - Date.now()) / 86400000);
}

describe('Kidney care class registration service (dae1efec)', () => {
  test('registers an in-person class using the in-person delivery rules', async () => {
    const result = await registerForClass({
      classCode: 'ks-intro-101',
      format: 'in_person',
      zipCode: '80202',
    });

    expect(result.confirmationNumber).toMatch(/^KS-/);
    expect(result.status).toBe('registered');
    expect(result.classCode).toBe('ks-intro-101');
    expect(result.delivery).toBe(DELIVERY_FORMATS.in_person.label);
    expect(result.materialsKit).toBe(DELIVERY_FORMATS.in_person.materialsKit);
    expect(daysFromNow(result.earliestSessionAt)).toBe(DELIVERY_FORMATS.in_person.leadTimeDays);
  });

  test('registers a virtual class using the virtual delivery rules', async () => {
    const result = await registerForClass({
      classCode: 'ks-nutrition-201',
      format: 'virtual',
      zipCode: '10001',
    });

    expect(result.delivery).toBe(DELIVERY_FORMATS.virtual.label);
    expect(result.materialsKit).toBe(DELIVERY_FORMATS.virtual.materialsKit);
    expect(daysFromNow(result.earliestSessionAt)).toBe(DELIVERY_FORMATS.virtual.leadTimeDays);
  });

  test('falls back to in-person rules for an unknown delivery format', async () => {
    const result = await registerForClass({
      classCode: 'ks-intro-101',
      format: 'hologram',
    });

    expect(result.delivery).toBe(DELIVERY_FORMATS.in_person.label);
    expect(daysFromNow(result.earliestSessionAt)).toBe(DELIVERY_FORMATS.in_person.leadTimeDays);
  });

  test('uses the class default format when none is requested', async () => {
    const result = await registerForClass({ classCode: 'ks-nutrition-201' });

    expect(result.delivery).toBe(DELIVERY_FORMATS.virtual.label);
    expect(daysFromNow(result.earliestSessionAt)).toBe(DELIVERY_FORMATS.virtual.leadTimeDays);
  });

  test('registers the first catalog class when the class code is unknown', async () => {
    const result = await registerForClass({ classCode: 'not-a-class', format: 'in_person' });

    expect(result.classCode).toBe(CLASS_CATALOG[0].classCode);
    expect(result.zipCode).toBe('80202');
  });

  test('every catalog class declares a format with delivery rules', () => {
    for (const entry of CLASS_CATALOG) {
      expect(DELIVERY_FORMATS[entry.format]).toBeDefined();
      expect(typeof DELIVERY_FORMATS[entry.format].leadTimeDays).toBe('number');
    }
  });
});
