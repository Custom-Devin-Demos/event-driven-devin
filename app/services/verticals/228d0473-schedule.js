/**
 * Builds the schedule of cover for a Masterpiece enquiry: every declared
 * valuable is placed in its section with the sublimit and excess that apply.
 */
const {
  CATEGORIES, buildSublimitIndex, sectionFor, sublimitKey,
} = require('./228d0473-catalog');

const SUBLIMITS = buildSublimitIndex();

function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || { id, label: id, section: 'CONT' };
}

function lookupSublimit(sectionCode, categoryLabel) {
  return SUBLIMITS.get(sublimitKey(sectionCode, categoryLabel));
}

function scheduleLine(item) {
  const cat = categoryOf(item.category);
  const sublimit = lookupSublimit(cat.section, cat.label);
  if (!sublimit) {
    const error = new Error(`No sublimit configured for category '${cat.id}' in section ${cat.section}`);
    error.statusCode = 422;
    throw error;
  }
  const insured = Math.min(item.value, sublimit.perItemLimit);
  return {
    category: cat.id,
    label: cat.label,
    section: sectionFor(cat.section).name,
    declaredValue: item.value,
    sumInsured: insured,
    excess: sublimit.excess,
    underinsured: item.value > insured,
  };
}

function buildSchedule(profile) {
  const lines = profile.valuables.map(scheduleLine);
  const totals = lines.reduce((acc, l) => {
    acc[l.section] = (acc[l.section] || 0) + l.sumInsured;
    return acc;
  }, {});
  return {
    lines,
    totals,
    buildingsSumInsured: profile.buildingsSumInsured,
    contentsSumInsured: profile.contentsSumInsured,
  };
}

module.exports = { buildSchedule, scheduleLine, lookupSublimit };
