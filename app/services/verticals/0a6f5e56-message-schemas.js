const MESSAGE_SCHEMAS = {
  'obc/3.2': {
    vendor: 'Peregrine Telematics',
    firmware: '3.2.x',
    envelope: 'flat',
    timestamps: 'epoch_s',
    fields: {
      type: 'msg_type',
      route: 'route_id',
      container: 'container_id',
      outcome: 'svc_result',
      odometer: 'odo_mi',
      occurredAt: 'ts',
      lat: 'lat',
      lon: 'lon',
    },
    eventCodes: {
      ROUTE_START: 'ROUTE_STARTED',
      SVC_COMPLETE: 'CONTAINER_SERVICED',
      SVC_EXCEPTION: 'SERVICE_EXCEPTION',
      ODOMETER: 'MILEAGE',
    },
    outcomes: {
      COMPLETE: 'CONTAINER_SERVICED',
      NOT_OUT: 'NOT_OUT',
      BLOCKED: 'BLOCKED',
      CONTAMINATED: 'CONTAMINATED',
    },
  },
};

function schemaFor(header) {
  return MESSAGE_SCHEMAS[header && header.schema];
}

function readField(body, fieldName) {
  return body[fieldName];
}

function toIsoTimestamp(value, encoding) {
  if (encoding === 'epoch_s') return new Date(value * 1000).toISOString();
  if (encoding === 'epoch_ms') return new Date(value).toISOString();
  return new Date(value).toISOString();
}

module.exports = { MESSAGE_SCHEMAS, schemaFor, readField, toIsoTimestamp };
