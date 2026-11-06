const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/linecontrol/changeover';

/**
 * Assembly lines managed by LineWorks MES, with the station sequence the
 * changeover downloads recipes to.
 */
const LINES = {
  L3: {
    name: 'Final Assembly Line 3',
    stations: [
      { id: 'ST10', name: 'Housing load', kind: 'load' },
      { id: 'ST20', name: 'Shaft press', kind: 'press' },
      { id: 'ST30', name: 'Bolt torque (6-spindle)', kind: 'torque' },
      { id: 'ST40', name: 'Leak test', kind: 'leak' },
      { id: 'ST50', name: 'Vision inspection', kind: 'vision' },
      { id: 'ST60', name: 'End-of-line test', kind: 'eol' },
      { id: 'ST70', name: 'Label & pack', kind: 'pack' },
    ],
  },
};

/**
 * Product models released to the line, with the station programs each one
 * runs. Program IDs resolve against the program libraries below.
 */
const MODELS = new Map([
  ['HX-300', {
    name: 'HX-300 hydraulic gear pump', cycleSec: 51.0, targetUph: 68,
    pressProgram: 'PR-18MM', torqueProgram: 'TQ-M10-STD', leakSpec: 'LK-180', visionJob: 'VJ-HX3', eolSuite: 'EOL-HX-A', label: 'LBL-HX-STD',
  }],
  ['HX-350', {
    name: 'HX-350 hydraulic gear pump', cycleSec: 53.5, targetUph: 65,
    pressProgram: 'PR-18MM', torqueProgram: 'TQ-M10-STD', leakSpec: 'LK-210', visionJob: 'VJ-HX3', eolSuite: 'EOL-HX-A', label: 'LBL-HX-STD',
  }],
  ['HX-450', {
    name: 'HX-450 heavy-duty gear pump', cycleSec: 57.5, targetUph: 62,
    pressProgram: 'PR-22MM', torqueProgram: 'TQ-M12-HD', leakSpec: 'LK-250', visionJob: 'VJ-HX4', eolSuite: 'EOL-HX-B', label: 'LBL-HX-HD',
  }],
  ['HX-450-G2', {
    name: 'HX-450 Gen 2 heavy-duty gear pump', cycleSec: 58.0, targetUph: 62, ecn: 'ECN-24117',
    pressProgram: 'PR-22MM', torqueProgram: 'TQ-M12-HD-G2', leakSpec: 'LK-250', visionJob: 'VJ-HX4-G2', eolSuite: 'EOL-HX-B', label: 'LBL-HX-HD',
  }],
]);

/**
 * Engineering change notices released to the line. Each one lists the station
 * programs it introduces so MES and the station controllers stay in step.
 */
const ENGINEERING_CHANGES = {
  'ECN-24117': {
    title: 'HX-450 Gen 2: housing bolts M12 8.8 -> M12 10.9, revised vision job',
    released: '2026-11-04',
    programs: {
      'TQ-M12-HD-G2': 'Bolt torque 98 Nm (window 94-102 Nm), angle 40 deg (window 30-50), 6 spindles',
      'VJ-HX4-G2': 'Vision job for Gen 2 housing casting marks',
    },
  },
};

const PRESS_PROGRAMS = {
  'PR-18MM': { forceKn: 14.0, strokeMm: 42.0 },
  'PR-22MM': { forceKn: 19.5, strokeMm: 48.5 },
};

// Torque programs, as exported from the ST30 nutrunner controller.
const TORQUE_PROGRAMS = {
  'TQ-M10-STD': { targetNm: 48, minNm: 45.5, maxNm: 50.5, angleDeg: 35, minAngleDeg: 25, maxAngleDeg: 45, spindles: 4 },
  'TQ-M12-HD': { targetNm: 85, minNm: 81, maxNm: 89, angleDeg: 38, minAngleDeg: 28, maxAngleDeg: 48, spindles: 6 },
};

const LEAK_SPECS = {
  'LK-180': { testBar: 180, maxDecayPa: 120 },
  'LK-210': { testBar: 210, maxDecayPa: 110 },
  'LK-250': { testBar: 250, maxDecayPa: 100 },
};

const VISION_JOBS = {
  'VJ-HX3': { camera: 'CAM-50A', checks: 9 },
  'VJ-HX4': { camera: 'CAM-50A', checks: 11 },
  'VJ-HX4-G2': { camera: 'CAM-50A', checks: 12 },
};

const EOL_SUITES = {
  'EOL-HX-A': { steps: 14, maxFlowLpm: 42 },
  'EOL-HX-B': { steps: 17, maxFlowLpm: 58 },
};

function stationRecipe(station, model) {
  switch (station.kind) {
    case 'load':
      return { recipe: `LD-${model.label}`, fixture: model.pressProgram === 'PR-22MM' ? 'FX-HD' : 'FX-STD' };
    case 'press': {
      const press = PRESS_PROGRAMS[model.pressProgram];
      return { recipe: model.pressProgram, forceKn: press.forceKn, strokeMm: press.strokeMm };
    }
    case 'torque': {
      const torque = TORQUE_PROGRAMS[model.torqueProgram];
      return {
        recipe: model.torqueProgram,
        targetNm: torque.targetNm,
        torqueWindowNm: [torque.minNm, torque.maxNm],
        angleWindowDeg: [torque.minAngleDeg, torque.maxAngleDeg],
        spindles: torque.spindles,
      };
    }
    case 'leak': {
      const leak = LEAK_SPECS[model.leakSpec];
      return { recipe: model.leakSpec, testBar: leak.testBar, maxDecayPa: leak.maxDecayPa };
    }
    case 'vision': {
      const job = VISION_JOBS[model.visionJob];
      return { recipe: model.visionJob, camera: job.camera, checks: job.checks };
    }
    case 'eol': {
      const suite = EOL_SUITES[model.eolSuite];
      return { recipe: model.eolSuite, steps: suite.steps, maxFlowLpm: suite.maxFlowLpm };
    }
    default:
      return { recipe: model.label };
  }
}

/**
 * Change a line over to a new model: resolve every station's recipe and
 * download it, then release the line to run at the model's rate.
 */
async function changeoverLine(request, options = {}) {
  const startTime = Date.now();
  const changeoverId = uuidv4();
  const lineId = String(request.line || 'L3').toUpperCase();
  const modelId = String(request.model || '').toUpperCase();
  const workOrder = request.workOrder ? String(request.workOrder).slice(0, 32) : null;

  logger.info('Line changeover requested', {
    changeoverId, line: lineId, model: modelId, workOrder, service: 'line-control-api', route: ROUTE,
  });

  try {
    const line = LINES[lineId];
    if (!line) {
      const error = new Error(`Unknown line: ${lineId}`);
      error.code = 'LINE_NOT_FOUND';
      throw error;
    }
    const model = MODELS.get(modelId);
    if (!model) {
      const error = new Error(`Model not released to ${lineId}: ${modelId}`);
      error.code = 'MODEL_NOT_FOUND';
      throw error;
    }

    const stations = line.stations.map((station) => ({
      station: station.id,
      name: station.name,
      status: 'DOWNLOADED',
      ...stationRecipe(station, model),
    }));
    const duration = Date.now() - startTime;

    incrementMetric('linecontrol.changeover.success', { route: ROUTE, line: lineId });
    recordTiming('linecontrol.changeover.latency', duration, { route: ROUTE });

    return {
      success: true,
      changeoverId,
      line: lineId,
      lineName: line.name,
      model: modelId,
      modelName: model.name,
      workOrder,
      status: 'RUNNING',
      cycleSec: model.cycleSec,
      targetUph: model.targetUph,
      stations,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('linecontrol.changeover.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('linecontrol.changeover.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Line changeover failed', {
      changeoverId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, line: lineId, model: modelId, workOrder,
    });
    if (error.code !== 'LINE_NOT_FOUND' && error.code !== 'MODEL_NOT_FOUND') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'line-control-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { changeoverId, line: lineId, model: modelId, workOrder },
      });
    }
    throw error;
  }
}

module.exports = { changeoverLine, LINES, MODELS, ENGINEERING_CHANGES };
