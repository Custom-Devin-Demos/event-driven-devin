/**
 * Masterpiece (SG) cover catalogue: sections, valuables categories and the
 * per-item sublimits that apply to each category within a section.
 */

const SECTIONS = Object.freeze([
  { code: 'BLDG', name: 'Buildings', basis: 'replacement' },
  { code: 'CONT', name: 'Contents', basis: 'replacement' },
  { code: 'VALU', name: 'Valuable Articles', basis: 'agreed' },
]);

const CATEGORIES = Object.freeze([
  { id: 'jewellery', label: 'Jewellery & Watches', section: 'VALU', perItemLimit: 150000, excess: 0 },
  { id: 'fine_art', label: 'Art Collection', section: 'VALU', perItemLimit: 400000, excess: 0 },
  { id: 'wine_spirits', label: 'Wine & Whisky Collection', section: 'VALU', perItemLimit: 25000, excess: 250 },
  { id: 'handbags', label: 'Handbags', section: 'CONT', perItemLimit: 20000, excess: 250 },
  { id: 'musical_instruments', label: 'Musical Instruments', section: 'CONT', perItemLimit: 30000, excess: 250 },
  { id: 'silverware', label: 'Silverware', section: 'CONT', perItemLimit: 15000, excess: 250 },
  { id: 'furniture', label: 'Furniture', section: 'CONT', perItemLimit: 50000, excess: 500 },
  { id: 'fixtures', label: 'Fixtures & Fittings', section: 'BLDG', perItemLimit: 80000, excess: 1000 },
]);

function sublimitKey(sectionCode, categoryLabel) {
  return `${sectionCode}/${categoryLabel}`.toUpperCase();
}

function buildSublimitIndex(categories = CATEGORIES) {
  const index = new Map();
  for (const cat of categories) {
    index.set(sublimitKey(cat.section, cat.label), { perItemLimit: cat.perItemLimit, excess: cat.excess });
  }
  return index;
}

function sectionFor(code) {
  return SECTIONS.find((s) => s.code === code);
}

module.exports = { SECTIONS, CATEGORIES, sublimitKey, buildSublimitIndex, sectionFor };
