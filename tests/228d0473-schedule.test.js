/* global describe, test, expect */

const { CATEGORIES, sectionFor } = require('../app/services/verticals/228d0473-catalog');
const { buildSchedule, scheduleLine, lookupSublimit } = require('../app/services/verticals/228d0473-schedule');
const { DEFAULT_PROFILE } = require('../app/services/verticals/228d0473');

describe('228d0473 schedule of cover', () => {
  test('builds a schedule for every category in the catalogue', () => {
    const profile = {
      buildingsSumInsured: 1000000,
      contentsSumInsured: 500000,
      valuables: CATEGORIES.map((c) => ({ category: c.id, value: 1000 })),
    };
    const schedule = buildSchedule(profile);
    expect(schedule.lines).toHaveLength(CATEGORIES.length);
    CATEGORIES.forEach((cat, i) => {
      expect(schedule.lines[i]).toMatchObject({
        category: cat.id,
        label: cat.label,
        section: sectionFor(cat.section).name,
        sumInsured: 1000,
        excess: cat.excess,
        underinsured: false,
      });
    });
  });

  test.each(CATEGORIES.map((c) => [c.id, c]))('caps %s at its per-item limit', (_id, cat) => {
    const line = scheduleLine({ category: cat.id, value: cat.perItemLimit + 1 });
    expect(line.sumInsured).toBe(cat.perItemLimit);
    expect(line.underinsured).toBe(true);
  });

  test('builds the default Masterpiece enquiry profile', () => {
    const schedule = buildSchedule(DEFAULT_PROFILE);
    expect(schedule.lines.map((l) => l.category)).toEqual(DEFAULT_PROFILE.valuables.map((v) => v.category));
    expect(schedule.lines.find((l) => l.category === 'wine_spirits')).toMatchObject({ sumInsured: 25000, underinsured: true });
  });

  test('every catalogue category resolves a sublimit', () => {
    CATEGORIES.forEach((cat) => {
      expect(lookupSublimit(cat.section, cat.label)).toEqual({ perItemLimit: cat.perItemLimit, excess: cat.excess });
    });
  });

  test('unknown category fails with a descriptive 422 instead of a TypeError', () => {
    let error;
    try { scheduleLine({ category: 'classic_cars', value: 1 }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.statusCode).toBe(422);
    expect(error.message).toMatch(/classic_cars/);
  });
});
