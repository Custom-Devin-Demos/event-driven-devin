const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.AMPLITUDE_SLACK_MEMBER_ID || 'U08S7AVJ478';

const CHART_TYPES = {
  event_segmentation: { label: 'Event Segmentation', metricLabel: 'Uniques' },
  funnel_analysis: { label: 'Funnel Analysis', metricLabel: 'Conversion' },
  retention_analysis: { label: 'Retention Analysis', metricLabel: 'Retained users' },
  user_sessions: { label: 'User Sessions', metricLabel: 'Sessions' },
};

const INTERVALS = {
  hourly: { label: 'Hourly' },
  daily: { label: 'Daily' },
  weekly: { label: 'Weekly' },
  monthly: { label: 'Monthly' },
};

const EVENTS = {
  checkout_completed: { label: 'Checkout Completed', baseline: 48200 },
  signup_completed: { label: 'Sign Up Completed', baseline: 21500 },
  session_start: { label: 'Session Start', baseline: 164000 },
  feature_activated: { label: 'Feature Activated', baseline: 9700 },
};

const HOUR_MS = 3600000;

// Rollup windows the query engine uses to bucket raw events before aggregation.
const ROLLUP_WINDOWS = {
  event_segmentation: {
    hourly: { bucketMs: HOUR_MS, maxBuckets: 168, table: 'events_hourly' },
    daily: { bucketMs: 24 * HOUR_MS, maxBuckets: 180, table: 'events_daily' },
    weekly: { bucketMs: 7 * 24 * HOUR_MS, maxBuckets: 104, table: 'events_weekly' },
  },
  funnel_analysis: {
    hourly: { bucketMs: HOUR_MS, maxBuckets: 168, table: 'funnel_hourly' },
    daily: { bucketMs: 24 * HOUR_MS, maxBuckets: 180, table: 'funnel_daily' },
    weekly: { bucketMs: 7 * 24 * HOUR_MS, maxBuckets: 104, table: 'funnel_weekly' },
    monthly: { bucketMs: 30 * 24 * HOUR_MS, maxBuckets: 36, table: 'funnel_monthly' },
  },
  retention_analysis: {
    daily: { bucketMs: 24 * HOUR_MS, maxBuckets: 180, table: 'retention_daily' },
    weekly: { bucketMs: 7 * 24 * HOUR_MS, maxBuckets: 104, table: 'retention_weekly' },
    monthly: { bucketMs: 30 * 24 * HOUR_MS, maxBuckets: 36, table: 'retention_monthly' },
  },
  user_sessions: {
    hourly: { bucketMs: HOUR_MS, maxBuckets: 168, table: 'sessions_hourly' },
    daily: { bucketMs: 24 * HOUR_MS, maxBuckets: 180, table: 'sessions_daily' },
    weekly: { bucketMs: 7 * 24 * HOUR_MS, maxBuckets: 104, table: 'sessions_weekly' },
    monthly: { bucketMs: 30 * 24 * HOUR_MS, maxBuckets: 36, table: 'sessions_monthly' },
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Amplitude Analytics chart query:',
  '- Service: `app/services/verticals/5826f4f2.js`',
  '- Route: `app/routes/verticals/5826f4f2.js`',
  '- Page: `app/public/verticals/5826f4f2.html` (served at `/amplitude`)',
  '',
  'Preserve the existing results for every chart type and interval that already works.',
  'Run `npx jest tests/5826f4f2-chart-query.test.js --runInBand` and `npm run lint`.',
  'Verify the chart at `/amplitude` renders for the affected chart type and interval.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validateQuery(data) {
  if (!data.projectId || !EVENTS[data.eventName]) {
    const error = new Error('Select a project and a tracked event before running the chart.');
    error.name = 'ValidationError';
    error.code = 'CHART_INPUTS_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  if (!CHART_TYPES[data.chartType] || !INTERVALS[data.interval]) {
    const error = new Error('Select a supported chart type and time interval.');
    error.name = 'ValidationError';
    error.code = 'CHART_CONFIG_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function resolveRollupWindow(chartType, interval) {
  return ROLLUP_WINDOWS[chartType][interval];
}

function buildChartSeries(queryId, data, rollup) {
  const chart = CHART_TYPES[data.chartType];
  const event = EVENTS[data.eventName];
  const lookbackMs = (data.lookbackDays || 90) * 24 * HOUR_MS;
  const bucketCount = Math.min(Math.max(Math.round(lookbackMs / rollup.bucketMs), 1), rollup.maxBuckets);
  const bucketDays = Math.round(rollup.bucketMs / (24 * HOUR_MS)) || 1;
  const now = Date.now();

  const series = [];
  for (let index = bucketCount - 1; index >= 0; index -= 1) {
    const bucketStart = new Date(now - index * rollup.bucketMs);
    const growth = 1 + (bucketCount - index) * 0.035;
    const wobble = 1 + Math.sin(index * 1.7) * 0.06;
    series.push({
      bucketStart: bucketStart.toISOString(),
      value: Math.round(event.baseline * (bucketDays / 7) * growth * wobble),
    });
  }

  const total = series.reduce((sum, point) => sum + point.value, 0);
  const previous = series.length > 1 ? series[series.length - 2].value : series[0].value;
  const latest = series[series.length - 1].value;

  return {
    success: true,
    queryId,
    status: 'complete',
    chart: {
      type: chart.label,
      metricLabel: chart.metricLabel,
      event: event.label,
      segmentBy: data.segmentBy || 'None',
      interval: INTERVALS[data.interval].label,
      lookbackDays: data.lookbackDays || 90,
    },
    rollup: {
      table: rollup.table,
      bucketMs: rollup.bucketMs,
      buckets: series.length,
    },
    results: {
      total,
      latest,
      changePct: Number((((latest - previous) / previous) * 100).toFixed(1)),
      series,
    },
  };
}

async function runChartQuery(data) {
  const startTime = Date.now();
  const queryId = `AMP-${uuidv4().slice(0, 8).toUpperCase()}`;

  validateQuery(data);

  logger.info('Running Amplitude chart query', {
    queryId,
    chartType: data.chartType,
    interval: data.interval,
    service: 'customer-5826f4f2-chart-query',
    route: '/api/5826f4f2/chart-query',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const rollup = resolveRollupWindow(data.chartType, data.interval);
    const result = buildChartSeries(queryId, data, rollup);
    const duration = Date.now() - startTime;

    incrementMetric('chart_query.run_success', {
      route: '/api/5826f4f2/chart-query',
      chartType: data.chartType,
      interval: data.interval,
    });
    recordTiming('chart_query.run_latency', duration, {
      route: '/api/5826f4f2/chart-query',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('chart_query.run_failure', {
      route: '/api/5826f4f2/chart-query',
      chartType: data.chartType,
      interval: data.interval,
      errorClass: error.name,
    });
    recordTiming('chart_query.run_latency', duration, {
      route: '/api/5826f4f2/chart-query',
      error: 'true',
    });

    logger.error('Amplitude chart query failed', {
      queryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      chartType: data.chartType,
      interval: data.interval,
      service: 'customer-5826f4f2-chart-query',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/5826f4f2/chart-query',
        service: 'customer-5826f4f2-chart-query',
        chartType: data.chartType,
        interval: data.interval,
      },
      extra: {
        queryId,
        projectId: data.projectId,
        eventName: data.eventName,
        segmentBy: data.segmentBy,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/5826f4f2.js — buildChartSeries',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-5826f4f2-chart-query',
      verticalLabel: 'Amplitude Analytics Chart',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '5826f4f2',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: '/api/5826f4f2/chart-query' },
        { key: 'service', value: 'customer-5826f4f2-chart-query' },
        { key: 'chart_type', value: data.chartType },
        { key: 'interval', value: data.interval },
      ],
      extra: {
        queryId,
        projectId: data.projectId,
        eventName: data.eventName,
        segmentBy: data.segmentBy,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-5826f4f2-chart-query@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Amplitude chart query error', {
        error: alertError.message,
        queryId,
      });
    });

    throw error;
  }
}

module.exports = {
  runChartQuery,
  resolveRollupWindow,
  buildChartSeries,
  CHART_TYPES,
  INTERVALS,
  EVENTS,
  ROLLUP_WINDOWS,
  REMEDIATION_DIRECTIVE,
};
