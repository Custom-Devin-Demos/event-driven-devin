const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

const COLUMN_MAP = {
  serial_number: 'serialNumber',
  part_number: 'partNumber',
  station_id: 'stationId',
  line_id: 'lineId',
  shift: 'shift',
  operator: 'operator',
  tested_at: 'testedAt',
};

function parseMeasurement(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!DECIMAL_PATTERN.test(text)) return null;
  return Number(text);
}

function parseRow(row, parameterNames) {
  const unit = {};
  Object.keys(COLUMN_MAP).forEach((column) => {
    unit[COLUMN_MAP[column]] = row[column];
  });
  unit.measurements = parameterNames.reduce((acc, name) => {
    acc[name] = parseMeasurement(row[name]);
    return acc;
  }, {});
  return unit;
}

function parseUpload(batch, parameterNames) {
  return batch.rows.map((row) => parseRow(row, parameterNames));
}

module.exports = { parseUpload, parseRow, parseMeasurement, COLUMN_MAP };
