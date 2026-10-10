/**
 * Wire-frame codec for the plant edge gateways that publish PLC readings onto
 * the sensor stream. Gateways on the 6.x firmware line publish a flat frame;
 * the 7.x line publishes a structured frame that references its schema in the
 * site schema registry.
 */

const SCHEMA_REGISTRY = {
  'sr://freeport/plc-edge/6.4.2': {
    ref: 'sr://freeport/plc-edge/6.4.2',
    firmwareLine: '6.x',
    addressing: 'flat',
    separator: '/',
    timestamp: 'epoch-ms',
  },
  'sr://freeport/plc-edge/7.0.1': {
    ref: 'sr://freeport/plc-edge/7.0.1',
    firmwareLine: '7.x',
    addressing: 'structured',
    separator: '/',
    timestamp: 'iso-8601',
  },
};

const QUALITY_CODES = {
  192: 'good',
  64: 'uncertain',
  0: 'bad',
};

function schemaRefFor(firmware) {
  return `sr://freeport/plc-edge/${firmware}`;
}

function encodeFrame(rack, tag, sample) {
  const base = { fw: rack.firmware, seq: sample.seq, src: rack.gatewayId };
  if (rack.firmware.startsWith('7.')) {
    return {
      ...base,
      schemaRef: schemaRefFor(rack.firmware),
      sig: { area: tag.area, unit: tag.unit, addr: tag.addr },
      val: { v: sample.value, q: sample.qualityCode },
      ts: new Date(sample.observedAt).toISOString(),
    };
  }
  return {
    ...base,
    tag: [tag.area, tag.unit, tag.addr].join('/'),
    value: sample.value,
    quality: QUALITY_CODES[sample.qualityCode] || 'bad',
    ts: sample.observedAt,
  };
}

async function resolveSchema(ref) {
  await new Promise((resolve) => setTimeout(resolve, 2 + Math.random() * 6));
  const schema = SCHEMA_REGISTRY[ref];
  if (!schema) {
    throw new Error(`Schema ${ref} is not registered`);
  }
  return schema;
}

function decodeFlat(frame) {
  return {
    tagPath: frame.tag,
    value: frame.value,
    quality: frame.quality,
    observedAt: frame.ts,
    firmware: frame.fw,
    gatewayId: frame.src,
    seq: frame.seq,
  };
}

function decodeStructured(frame, schema) {
  return {
    tagPath: [frame.sig.area, frame.sig.unit, frame.sig.addr].join(schema.separator),
    value: frame.val.v,
    quality: QUALITY_CODES[frame.val.q] || 'bad',
    observedAt: Date.parse(frame.ts),
    firmware: frame.fw,
    gatewayId: frame.src,
    seq: frame.seq,
  };
}

function decodeFrame(frame) {
  if (frame.schemaRef) {
    return resolveSchema(frame.schemaRef).then((schema) => decodeStructured(frame, schema));
  }
  return decodeFlat(frame);
}

module.exports = {
  SCHEMA_REGISTRY,
  QUALITY_CODES,
  encodeFrame,
  decodeFrame,
  decodeFlat,
  decodeStructured,
  resolveSchema,
  schemaRefFor,
};
