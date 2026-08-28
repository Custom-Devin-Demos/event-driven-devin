const { registerForClass, DELIVERY_FORMATS } = require('../app/services/verticals/dae1efec');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

describe('kidney care class registration', () => {
  it('registers an in-person class without throwing (original failure condition)', async () => {
    const confirmation = await registerForClass({
      classCode: 'ks-intro-101',
      format: 'in_person',
      zipCode: '80202',
    });

    expect(confirmation.status).toBe('registered');
    expect(confirmation.classCode).toBe('ks-intro-101');
    expect(confirmation.delivery).toBe(DELIVERY_FORMATS.in_person.label);
    expect(confirmation.materialsKit).toBe(DELIVERY_FORMATS.in_person.materialsKit);
    expect(Number.isNaN(Date.parse(confirmation.earliestSessionAt))).toBe(false);
  });

  it('applies the virtual delivery rules for a virtual class', async () => {
    const confirmation = await registerForClass({
      classCode: 'ks-nutrition-201',
      format: 'virtual',
      zipCode: '80202',
    });

    expect(confirmation.delivery).toBe(DELIVERY_FORMATS.virtual.label);
    expect(confirmation.materialsKit).toBe(DELIVERY_FORMATS.virtual.materialsKit);
  });

  it('falls back to in-person rules for a missing or unknown format', async () => {
    const missing = await registerForClass({ classCode: 'ks-intro-101' });
    const unknown = await registerForClass({ classCode: 'ks-intro-101', format: 'hologram' });

    for (const confirmation of [missing, unknown]) {
      expect(confirmation.status).toBe('registered');
      expect(confirmation.delivery).toBe(DELIVERY_FORMATS.in_person.label);
      expect(confirmation.earliestSessionAt).toEqual(expect.any(String));
    }
  });

  it('computes the earliest session date from the format lead time', async () => {
    const before = Date.now();
    const confirmation = await registerForClass({ classCode: 'ks-nutrition-201', format: 'virtual' });
    const offsetDays = (Date.parse(confirmation.earliestSessionAt) - before) / 86400000;

    expect(offsetDays).toBeGreaterThan(DELIVERY_FORMATS.virtual.leadTimeDays - 0.01);
    expect(offsetDays).toBeLessThan(DELIVERY_FORMATS.virtual.leadTimeDays + 0.01);
  });
});
