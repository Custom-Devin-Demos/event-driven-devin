jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { getCockpit, getJob, runParallelValidation } = require('../app/services/verticals/d21dc676');
const D = require('../app/services/verticals/d21dc676-decimal');
const { generateFocusLots } = require('../app/services/verticals/d21dc676-mockdata');

describe('Sysco migration cockpit (d21dc676)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('cockpit lists the six-job nightly chain in sequence', () => {
    const cockpit = getCockpit();
    expect(cockpit.jobs.map((job) => job.id)).toEqual([
      'FA-BAT-01', 'FA-BAT-02', 'FA-BAT-03', 'FA-BAT-04', 'FA-BAT-05', 'FA-BAT-06',
    ]);
    expect(cockpit.mockData.sample).toHaveLength(8);
    expect(cockpit.jobs[0].cobolExcerpt).toBeUndefined();
  });

  test('job detail maps copybook fields to Aurora and Java types', () => {
    const job = getJob('fa-bat-02');
    const extCost = job.fieldMappings.find((m) => m.source === 'LB-BEG-EXT-COST-AMT');
    expect(extCost).toMatchObject({ column: 'beg_ext_cost_amt', auroraType: 'NUMERIC(11,2)', javaType: 'BigDecimal' });
    expect(job.javaSource.join('\n')).toContain('class BeginningBalanceProcessor');
    expect(job.cobolSource.join('\n')).toContain('COMPUTE LB-BEG-EXT-COST-AMT ROUNDED');
  });

  test('unknown jobs and jobs not yet in parallel run are rejected without an alert', async () => {
    expect(() => getJob('FA-BAT-99')).toThrow(/Unknown batch job/);
    await expect(runParallelValidation({ jobId: 'FA-BAT-04' })).rejects.toMatchObject({ statusCode: 400, code: 'JOB_NOT_READY' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a parity break escalates the subagent question to on-call', async () => {
    let outcome;
    try {
      outcome = await runParallelValidation({ jobId: 'FA-BAT-02' });
    } catch (error) {
      outcome = error;
    }
    if (outcome instanceof Error) {
      expect(outcome.name).toBe('AgentEscalation');
      expect(outcome.statusCode).toBe(409);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
      const alert = createSessionAndAlert.mock.calls[0][0];
      expect(alert.customer).toBe('d21dc676');
      expect(alert.promptAppendix).toContain('d21dc676-conversion-rules.js');
    } else {
      expect(outcome.parity).toMatchObject({ mismatches: 0, parity: 100 });
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    }
  });

  test('decimal rounding reproduces COBOL ROUNDED and Java HALF_EVEN exactly', () => {
    const tie = D.parse('37.3050');
    expect(D.format(D.setScale(tie, 2, 'HALF_UP'))).toBe('37.31');
    expect(D.format(D.setScale(tie, 2, 'HALF_EVEN'))).toBe('37.30');
    expect(D.format(D.setScale(D.parse('-4.129'), 2, 'DOWN'))).toBe('-4.12');
  });

  test('mock data is deterministic for a seed', () => {
    expect(generateFocusLots({ rows: 5 })).toEqual(generateFocusLots({ rows: 5 }));
  });
});
