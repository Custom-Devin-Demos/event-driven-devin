const SEVERITY_RULES = {
  110: { weight: 95, priority: 'Urgent', description: 'Engine coolant temperature high' },
  1761: { weight: 65, priority: 'Planned', description: 'DEF level low' },
  100: { weight: 85, priority: 'Urgent', description: 'Engine oil pressure low' },
};

function normalizeEvent(sample) {
  if (sample.version === 3) return { ...sample };
  return { ...sample, code: `SPN ${sample.spn} FMI ${sample.fmi}` };
}

module.exports = { SEVERITY_RULES, normalizeEvent };
