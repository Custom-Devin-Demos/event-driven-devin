const FAULT_CODES = {
  '110-0': {
    spn: 110,
    fmi: 0,
    component: 'Engine Coolant Temperature',
    description: 'Above Normal',
    level: 3,
    action: 'Stop machine — coolant loss / overheat risk',
  },
  '100-1': {
    spn: 100,
    fmi: 1,
    component: 'Engine Oil Pressure',
    description: 'Below Normal',
    level: 3,
    action: 'Stop machine — lubrication pressure loss',
  },
  '190-0': {
    spn: 190,
    fmi: 0,
    component: 'Engine Speed',
    description: 'Overspeed',
    level: 3,
    action: 'Reduce load and stop machine safely',
  },
  '168-4': {
    spn: 168,
    fmi: 4,
    component: 'Battery Voltage',
    description: 'Low',
    level: 2,
    action: 'Inspect charging system at next service window',
  },
  '94-18': {
    spn: 94,
    fmi: 18,
    component: 'Fuel Delivery Pressure',
    description: 'Low',
    level: 2,
    action: 'Schedule fuel system inspection',
  },
  '1761-17': {
    spn: 1761,
    fmi: 17,
    component: 'DEF Tank Level',
    description: 'Low',
    level: 1,
    action: 'Refill DEF at next service stop',
  },
  '3251-0': {
    spn: 3251,
    fmi: 0,
    component: 'DPF Differential Pressure',
    description: 'High',
    level: 2,
    action: 'Schedule DPF regeneration inspection',
  },
  '171-3': {
    spn: 171,
    fmi: 3,
    component: 'Ambient Air Temperature Sensor',
    description: 'Voltage Above Normal',
    level: 1,
    action: 'Inspect sensor harness during next service',
  },
};

const SEVERITY = {
  1: 'advisory',
  2: 'warning',
  3: 'critical',
};

function decodeFaultEvents(events) {
  const byAsset = new Map();
  events.forEach((event) => {
    const code = `${event.spn}-${event.fmi}`;
    const definition = FAULT_CODES[code];
    if (!definition) return;
    if (!byAsset.has(event.serial)) {
      byAsset.set(event.serial, {
        assetSerial: event.serial,
        reportedAt: event.occurredAt,
        codes: [],
      });
    }
    const record = byAsset.get(event.serial);
    if (new Date(event.occurredAt) > new Date(record.reportedAt)) record.reportedAt = event.occurredAt;
    record.codes.push({
      code,
      spn: definition.spn,
      fmi: definition.fmi,
      component: definition.component,
      description: definition.description,
      severity: SEVERITY[definition.level],
      occurredAt: event.occurredAt,
      hoursAtFault: event.hoursAtFault,
    });
  });
  return Array.from(byAsset.values()).sort((a, b) => a.assetSerial.localeCompare(b.assetSerial));
}

module.exports = { FAULT_CODES, SEVERITY, decodeFaultEvents };
