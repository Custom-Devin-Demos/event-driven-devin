const OPERATOR_SCHEMAS = {
  SWA: {
    code: 'SWA',
    name: 'Southwind Airlines',
    engineFamily: 'LEAP-1B',
    fileFormat: 'csv',
    schemaVersion: 1,
    columns: {
      flightDate: 'FLIGHT_DATE',
      legId: 'LEG_ID',
      aircraftReg: 'AIRCRAFT_REG',
      esn: 'ENGINE_SERIAL_NUMBER',
      egtMarginC: 'EGT_MARGIN_C',
      vibrationN1: 'N1_VIBRATION',
      vibrationN2: 'N2_VIBRATION',
      oilPressureKpa: 'OIL_PRESSURE_KPA',
      oilConsumptionQtHr: 'OIL_CONSUMPTION_QT_HR',
      altitudeFt: 'ALTITUDE_FT',
    },
    units: {
      egt: 'C',
      oilPressure: 'kPa',
    },
  },
  DLH: {
    code: 'DLH',
    name: 'Nordlicht Air',
    engineFamily: 'GEnx-1B',
    fileFormat: 'json',
    schemaVersion: 1,
    columns: {
      flightDate: 'flight_date',
      legId: 'leg_id',
      aircraftReg: 'aircraft_registration',
      esn: 'engine_serial_number',
      egtMarginC: 'egt_margin_c',
      vibrationN1: 'vibration_n1',
      vibrationN2: 'vibration_n2',
      oilPressureKpa: 'oil_pressure_kpa',
      oilConsumptionQtHr: 'oil_consumption_qt_hr',
      altitudeFt: 'altitude_ft',
    },
    units: {
      egt: 'C',
      oilPressure: 'kPa',
    },
  },
  QFA: {
    code: 'QFA',
    name: 'Coral Sea Airways',
    engineFamily: 'CF6-80C2',
    fileFormat: 'csv',
    schemaVersion: 1,
    columns: {
      flightDate: 'FLIGHT_DATE',
      legId: 'LEG',
      aircraftReg: 'REGISTRATION',
      esn: 'ESN',
      egtMarginC: 'EGT_MARGIN_C',
      vibrationN1: 'VIB_N1',
      vibrationN2: 'VIB_N2',
      oilPressureKpa: 'OIL_PRESSURE_KPA',
      oilConsumptionQtHr: 'OIL_CONSUMPTION_QT_HR',
      altitudeFt: 'ALTITUDE',
    },
    units: {
      egt: 'C',
      oilPressure: 'kPa',
    },
  },
  MPX: {
    code: 'MPX',
    name: 'Meridian Pacific Express',
    engineFamily: 'LEAP-1A',
    fileFormat: 'json',
    schemaVersion: 2,
    columns: {
      flightDate: 'FLIGHT_DATE_UTC',
      legId: 'LEG_IDENTIFIER',
      aircraftReg: 'TAIL_NUMBER',
      esn: 'ENGINE_SERIAL',
      egtMarginC: 'EGT_MARGIN_F',
      vibrationN1: 'N1_VIB_IPS',
      vibrationN2: 'N2_VIB_IPS',
      oilPressureKpa: 'OIL_PRESS_PSI',
      oilConsumptionQtHr: 'OIL_BURN_QT_HR',
      altitudeFt: 'PRESSURE_ALTITUDE_FT',
    },
    unitSystem: {
      temperature: 'degF',
      pressure: 'psi',
    },
  },
};

function getOperatorSchema(code) {
  return OPERATOR_SCHEMAS[code] || null;
}

module.exports = { OPERATOR_SCHEMAS, getOperatorSchema };
