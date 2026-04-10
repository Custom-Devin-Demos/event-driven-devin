const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * HIL nightly test results registry
 */
const NIGHTLY_RESULTS = [
  { testId: 'HIL-PCM-001', suite: 'Powertrain Control', name: 'Engine idle stability at operating temp', status: 'pass', duration: 12.4, ecu: 'PCM_v8.3.1' },
  { testId: 'HIL-PCM-002', suite: 'Powertrain Control', name: 'Torque request arbitration under load', status: 'pass', duration: 18.7, ecu: 'PCM_v8.3.1' },
  { testId: 'HIL-TCM-014', suite: 'Transmission', name: 'Shift schedule verification (D mode)', status: 'pass', duration: 34.2, ecu: 'TCM_v5.1.0' },
  { testId: 'HIL-ADAS-031', suite: 'ADAS Sensor Fusion', name: 'Radar+Camera object correlation (75mph)', status: 'fail', duration: 45.8, ecu: 'ADAS_v12.0.4' },
  { testId: 'HIL-ADAS-032', suite: 'ADAS Sensor Fusion', name: 'Lane departure warning calibration', status: 'pass', duration: 22.1, ecu: 'ADAS_v12.0.4' },
  { testId: 'HIL-BMS-008', suite: 'Battery Management', name: 'Cell balancing during fast charge', status: 'pass', duration: 58.3, ecu: 'BMS_v3.2.7' },
  { testId: 'HIL-BCM-019', suite: 'Body Control', name: 'CAN bus wake/sleep cycle timing', status: 'pass', duration: 8.9, ecu: 'BCM_v6.0.2' },
  { testId: 'HIL-EPS-005', suite: 'Steering', name: 'EPS torque assist curve validation', status: 'skip', duration: 0, ecu: 'EPS_v4.1.3' },
];

/**
 * Signal profile configurations with raw sensor parameters.
 * Each profile stores speed in km/h internally for metric-based ECU processing.
 */
const SIGNAL_PROFILES = {
  highway_75mph: { speedKmh: 120.7, radarRangeMeters: 250, cameraFps: 30, fusionWindowMs: 50 },
  urban_35mph: { speedKmh: 56.3, radarRangeMeters: 120, cameraFps: 30, fusionWindowMs: 80 },
  parking_5mph: { speedKmh: 8.0, radarRangeMeters: 30, cameraFps: 15, fusionWindowMs: 150 },
};

/**
 * Parse raw sensor telemetry frame from the HIL bench.
 * Returns structured frame data with measurements array.
 */
function parseSensorFrame(testId, sampleRate, profileConfig) {
  const frameId = uuidv4().slice(0, 8);
  const timestamp = Date.now();

  const measurements = [
    { channel: 'RADAR_RANGE', value: profileConfig.radarRangeMeters, unit: 'meters' },
    { channel: 'CAMERA_FPS', value: profileConfig.cameraFps, unit: 'fps' },
    { channel: 'VEHICLE_SPEED', value: profileConfig.speedKmh, unit: 'kmh' },
    { channel: 'FUSION_WINDOW', value: profileConfig.fusionWindowMs, unit: 'ms' },
    { channel: 'SAMPLE_RATE', value: sampleRate, unit: 'hz' },
  ];

  return {
    frameId,
    testId,
    timestamp,
    measurements,
    channelCount: measurements.length,
  };
}

/**
 * Normalize sensor frame data for ECU consumption.
 * Converts units and restructures into the format expected by the analysis engine.
 */
function normalizeSensorData(frameData) {
  const normalized = {};
  for (const m of frameData.measurements) {
    normalized[m.channel] = {
      raw: m.value,
      converted: convertUnit(m.value, m.unit),
      timestamp: frameData.timestamp,
    };
  }
  return {
    frameId: frameData.frameId,
    testId: frameData.testId,
    data: normalized,
    totalChannels: frameData.channelCount,
  };
}

/**
 * Convert a measurement value from its source unit to the ECU standard unit.
 */
function convertUnit(value, unit) {
  switch (unit) {
  case 'kmh':
    return { value: value * 0.621371, unit: 'mph' };
  case 'meters':
    return { value: value * 3.28084, unit: 'feet' };
  case 'ms':
    return { value: value / 1000, unit: 'seconds' };
  case 'fps':
    return { value: value, unit: 'fps' };
  case 'hz':
    return { value: value, unit: 'hz' };
  default:
    return { value, unit };
  }
}

/**
 * Analyze normalized sensor data against ECU thresholds.
 * Performs correlation checks and generates a test verdict.
 */
function analyzeTestResults(normalizedData) {
  const speed = normalizedData.sensors.VEHICLE_SPEED.converted.value;
  const radarRange = normalizedData.sensors.RADAR_RANGE.converted.value;
  const fusionWindow = normalizedData.sensors.FUSION_WINDOW.converted;
  const sampleRate = normalizedData.sensors.SAMPLE_RATE.converted.value;

  const correlationScore = computeCorrelation(speed, radarRange, fusionWindow, sampleRate);

  const verdict = correlationScore >= 0.95 ? 'PASS' : 'FAIL';

  return {
    testId: normalizedData.testId,
    frameId: normalizedData.frameId,
    correlationScore: Math.round(correlationScore * 10000) / 10000,
    verdict,
    channelsAnalyzed: normalizedData.totalChannels,
    thresholds: { minCorrelation: 0.95, maxFusionLatency: 0.1 },
  };
}


/**
 * Compute radar-camera correlation score.
 * Uses speed, radar range, fusion timing, and sample rate to determine
 * whether sensor fusion meets real-time requirements.
 */
function computeCorrelation(speedMph, radarRangeFt, fusionWindowData, sampleRateHz) {
  const reactionDistanceFt = speedMph * 1.467;

  const coverageRatio = Math.min(radarRangeFt / reactionDistanceFt, 1.0);

  const fusionLatency = fusionWindowData.value;
  const maxLatency = fusionWindowData.threshold;
  const latencyScore = Math.max(0, 1 - (fusionLatency / maxLatency));

  const nyquistRatio = Math.min(sampleRateHz / 100, 1.0);

  return (coverageRatio * 0.4) + (latencyScore * 0.4) + (nyquistRatio * 0.2);
}

/**
 * Execute a HIL test re-run with full sensor pipeline.
 */
async function rerunHilTest(data) {
  const startTime = Date.now();
  const executionId = uuidv4();

  logger.info('HIL test re-run initiated', {
    executionId,
    testId: data.testId,
    ecuTarget: data.ecuTarget,
    signalProfile: data.signalProfile,
    sampleRate: data.sampleRate,
    service: 'hil-test-platform',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 180));

    const profileConfig = SIGNAL_PROFILES[data.signalProfile];
    if (!profileConfig) {
      throw new Error(`Unknown signal profile: ${data.signalProfile}`);
    }

    const sensorFrame = parseSensorFrame(data.testId, data.sampleRate, profileConfig);

    const normalizedData = normalizeSensorData(sensorFrame);

    const results = analyzeTestResults(normalizedData);

    const duration = Date.now() - startTime;

    incrementMetric('hil.test.rerun', {
      route: '/api/13ec88e4/rerun',
      verdict: results.verdict,
    });
    recordTiming('hil.test.latency', duration, {
      route: '/api/13ec88e4/rerun',
    });

    return {
      success: true,
      executionId,
      testId: results.testId,
      verdict: results.verdict,
      correlationScore: results.correlationScore,
      channelsAnalyzed: results.channelsAnalyzed,
      duration: `${(duration / 1000).toFixed(1)}s`,
      ecuTarget: data.ecuTarget,
      signalProfile: data.signalProfile,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('hil.test.failure', {
      route: '/api/13ec88e4/rerun',
      errorClass: error.name,
    });
    recordTiming('hil.test.latency', duration, {
      route: '/api/13ec88e4/rerun',
      error: 'true',
    });

    logger.error('HIL test re-run failed', {
      executionId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      testId: data.testId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/13ec88e4/rerun',
        service: 'hil-test-platform',
        ecuTarget: data.ecuTarget,
      },
      extra: { executionId, testId: data.testId, signalProfile: data.signalProfile },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/13ec88e4.js — rerunHilTest',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      service: 'hil-test-platform',
      verticalLabel: 'HIL Test',
      tags: [
        { key: 'route', value: '/api/13ec88e4/rerun' },
        { key: 'service', value: 'hil-test-platform' },
      ],
      extra: { executionId, testId: data.testId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-13ec88e4@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from HIL test error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { rerunHilTest, NIGHTLY_RESULTS, SIGNAL_PROFILES };
