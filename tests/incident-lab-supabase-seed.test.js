const fs = require('fs');
const path = require('path');
const { createSupabaseSeedSink, executableSql } = require('../app/services/incident-lab/supabase-seed');

const SEED_FILE = path.join(__dirname, '..', 'scripts', 'incident-lab', 'seed-flowforge-supabase.sql');

function makeRun(warehouse) {
  return {
    runRef: 'LAB-2026-09-02-TEST1',
    scenario: { id: 'test-scenario', warehouse },
    log: [],
  };
}

describe('Incident Lab warehouse seed', () => {
  const previous = {
    INCIDENT_LAB_WAREHOUSE_URL: process.env.INCIDENT_LAB_WAREHOUSE_URL,
    SUPABASE_WAREHOUSE_URL: process.env.SUPABASE_WAREHOUSE_URL,
  };

  beforeEach(() => {
    delete process.env.SUPABASE_WAREHOUSE_URL;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('runs the scenario seed on arm and records it on the run log', async () => {
    process.env.INCIDENT_LAB_WAREHOUSE_URL = 'postgres://seed';
    const run = jest.fn().mockResolvedValue();
    const sink = createSupabaseSeedSink({ deps: { run, read: () => 'insert into t values (1);\ncommit;' } });
    const state = makeRun({ seedFile: 'seed-flowforge-supabase.sql' });

    await sink.onArm(state);

    expect(run).toHaveBeenCalledWith('postgres://seed', expect.stringContaining('insert into t'));
    expect(state.log.map((entry) => entry.message)).toEqual(['warehouse seed applied']);
  });

  test('a seed failure is reported but never blocks the run', async () => {
    process.env.INCIDENT_LAB_WAREHOUSE_URL = 'postgres://seed';
    const sink = createSupabaseSeedSink({
      deps: { run: jest.fn().mockRejectedValue(new Error('connection refused')), read: () => 'commit;' },
    });
    const state = makeRun({ seedFile: 'seed-flowforge-supabase.sql' });

    await expect(sink.onArm(state)).resolves.toBeUndefined();
    expect(state.log[0].message).toBe('warehouse seed failed: connection refused');
  });

  test('says so when no warehouse is configured, and stays silent for scenarios without a seed', async () => {
    delete process.env.INCIDENT_LAB_WAREHOUSE_URL;
    const run = jest.fn();
    const sink = createSupabaseSeedSink({ deps: { run, read: () => 'commit;' } });

    const seeded = makeRun({ seedFile: 'seed-flowforge-supabase.sql' });
    await sink.onArm(seeded);
    expect(seeded.log[0].message).toBe('warehouse seed skipped (no warehouse URL configured)');

    const unseeded = makeRun(undefined);
    await sink.onArm(unseeded);
    expect(unseeded.log).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  test('a scenario cannot point the seed outside the seed directory', async () => {
    process.env.INCIDENT_LAB_WAREHOUSE_URL = 'postgres://seed';
    const run = jest.fn();
    const sink = createSupabaseSeedSink({ deps: { run, read: () => 'commit;' } });
    const state = makeRun({ seedFile: '../../secrets.sql' });

    await sink.onArm(state);

    expect(run).not.toHaveBeenCalled();
    expect(state.log).toEqual([]);
  });

  test('the shipped seed reduces to a single runnable transaction', () => {
    const sql = executableSql(fs.readFileSync(SEED_FILE, 'utf8'));

    // psql meta-commands and the presenter-facing verification queries after
    // the transaction cannot go over the wire.
    expect(sql).not.toMatch(/^\\/m);
    expect(sql).not.toContain('== project slug');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).toContain('create schema if not exists flowforge');
    expect(sql).toContain('on conflict');
  });
});
