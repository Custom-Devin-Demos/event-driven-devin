// Data-source manifests for each production line feeding the historian → MES
// interval-ingest job at Talon Power Systems, Kingsport Engine Plant (Plant 07).
//
// Every line lands in the historian through a different adapter, so each
// manifest declares how that line's tags are named, which quality encoding
// the adapter stamps on each sample, and how the machine state word is
// modelled. `columns` maps canonical fields to the tag / DataItem the
// adapter actually publishes.

const LINE_MANIFESTS = {
  L1: {
    code: 'L1',
    name: 'Line 1 — Block Machining',
    area: 'Machining',
    controller: 'FANUC 31i-B5 (x6 cells)',
    adapter: 'MTConnect Agent 1.8 → Historian',
    protocol: 'mtconnect',
    scanClass: '1 s',
    manifestVersion: 3,
    stateModel: 'mtconnect-execution',
    quality: { encoding: 'mtconnect' },
    columns: {
      sampleTime: 'timestamp',
      lineId: 'deviceUuid',
      cellId: 'dataItemId',
      state: 'Execution',
      rate: 'PathFeedrate',
      goodCount: 'PartCount.good',
      rejectCount: 'PartCount.reject',
      quality: 'availability',
      downtimeReason: 'Condition.Fault',
    },
    targetRatePerHr: 42,
    cells: ['BM-101', 'BM-102', 'BM-103', 'BM-104', 'BM-105', 'BM-106'],
  },
  L2: {
    code: 'L2',
    name: 'Line 2 — Head Machining',
    area: 'Machining',
    controller: 'Okuma OSP-P300 (x4 cells)',
    adapter: 'MTConnect Agent 1.8 → Historian',
    protocol: 'mtconnect',
    scanClass: '1 s',
    manifestVersion: 3,
    stateModel: 'mtconnect-execution',
    quality: { encoding: 'mtconnect' },
    columns: {
      sampleTime: 'timestamp',
      lineId: 'deviceUuid',
      cellId: 'dataItemId',
      state: 'Execution',
      rate: 'PathFeedrate',
      goodCount: 'PartCount.good',
      rejectCount: 'PartCount.reject',
      quality: 'availability',
      downtimeReason: 'Condition.Fault',
    },
    targetRatePerHr: 58,
    cells: ['HM-201', 'HM-202', 'HM-203', 'HM-204'],
  },
  L3: {
    code: 'L3',
    name: 'Line 3 — Final Assembly',
    area: 'Assembly',
    controller: 'Allen-Bradley ControlLogix 1756-L83E',
    adapter: 'Kepware KEPServerEX 6 (OPC DA) → Historian',
    protocol: 'opcda',
    scanClass: '500 ms',
    manifestVersion: 4,
    stateModel: 'packml',
    quality: { encoding: 'opcda' },
    columns: {
      sampleTime: 'TIMESTAMP',
      lineId: 'LINE_ID',
      cellId: 'STATION_ID',
      state: 'L3_PackML_State',
      rate: 'L3_Rate_PV',
      goodCount: 'L3_Good_Count',
      rejectCount: 'L3_Reject_Count',
      quality: 'QUALITY',
      downtimeReason: 'L3_DT_Reason_Code',
    },
    targetRatePerHr: 36,
    cells: ['FA-301', 'FA-302', 'FA-303', 'FA-304', 'FA-305', 'FA-306', 'FA-307', 'FA-308'],
  },
  L4: {
    code: 'L4',
    name: 'Line 4 — Hot Test',
    area: 'Test',
    controller: 'Siemens SIMATIC S7-1500 (CPU 1516-3 PN/DP)',
    adapter: 'Native OPC UA server → Historian (cutover 2026-09-24)',
    protocol: 'opcua',
    scanClass: '250 ms',
    manifestVersion: 5,
    stateModel: 'packml',
    quality: { encoding: 'opcua-statuscode' },
    columns: {
      sampleTime: 'SourceTimestamp',
      lineId: 'ns=3;s=Plant07.L4.LineId',
      cellId: 'ns=3;s=Plant07.L4.CellId',
      state: 'ns=3;s=Plant07.L4.PackML.StateCurrent',
      rate: 'ns=3;s=Plant07.L4.Rate_PV',
      goodCount: 'ns=3;s=Plant07.L4.Counters.Good',
      rejectCount: 'ns=3;s=Plant07.L4.Counters.Reject',
      quality: 'StatusCode',
      downtimeReason: 'ns=3;s=Plant07.L4.Downtime.ReasonCode',
    },
    targetRatePerHr: 30,
    cells: ['HT-401', 'HT-402', 'HT-403', 'HT-404'],
  },
};

function getLineManifest(code) {
  return Object.prototype.hasOwnProperty.call(LINE_MANIFESTS, code) ? LINE_MANIFESTS[code] : null;
}

module.exports = { LINE_MANIFESTS, getLineManifest };
