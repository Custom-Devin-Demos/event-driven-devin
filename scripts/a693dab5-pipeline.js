#!/usr/bin/env node

const logger = require('../app/telemetry/logger');
const service = require('../app/services/verticals/a693dab5');
const { OPERATOR_SCHEMAS } = require('../app/services/verticals/a693dab5-operator-schemas');

const { STAGES, ENGINES, EXCEEDANCES } = service;

function parseArgs(args) {
  const options = { operator: 'all', json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--operator') {
      options.operator = args[index + 1];
      index += 1;
    } else if (argument.startsWith('--operator=')) {
      options.operator = argument.slice('--operator='.length);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function silenceLogs() {
  logger.silent = true;
}

function stageIndex(stage) {
  return STAGES.indexOf(stage);
}

function countOperatorExceedances(code) {
  return EXCEEDANCES.filter((entry) => ENGINES[entry.esn]
    && ENGINES[entry.esn].operatorCode === code).length;
}

function printOperatorResult(code, run, exceedancesRaised) {
  const schema = OPERATOR_SCHEMAS[code];
  const reached = stageIndex(run.stageReached);
  console.log(`Operator ${code}  (${schema.name}, ${schema.engineFamily}, manifest v${schema.schemaVersion}, ${schema.fileFormat})`);
  STAGES.forEach((stage, index) => {
    const label = stage.padEnd(22);
    if (index > reached) {
      console.log(`  ${label} skipped`);
      return;
    }
    if (index === reached && run.status === 'failed') {
      console.log(`  ${label} FAILED  ${run.error.name}: ${run.error.message}`);
      return;
    }
    if (stage === 'ingest') {
      console.log(`  ${label} ok      ${run.rowsIn} rows in`);
    } else if (stage === 'publish') {
      console.log(`  ${label} ok      ${run.rowsOut} rows out`);
    } else if (stage === 'evaluate_exceedances') {
      console.log(`  ${label} ok      ${exceedancesRaised} exceedances raised`);
    } else {
      console.log(`  ${label} ok`);
    }
  });
  console.log(`  run ${run.runId}  status=${run.status}  rowsIn=${run.rowsIn} rowsOut=${run.rowsOut} duration=${run.durationMs}ms`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const operators = options.operator === 'all'
    ? Object.keys(OPERATOR_SCHEMAS)
    : [options.operator];
  const unknown = operators.find((code) => !OPERATOR_SCHEMAS[code]);
  if (unknown) throw new Error(`Unknown operator: ${unknown}`);

  silenceLogs();
  service.resetStore();
  const runs = [];
  for (const code of operators) {
    const before = countOperatorExceedances(code);
    let run;
    try {
      run = await service.runPipeline(code, { trigger: 'cli' });
    } catch (error) {
      run = service.listRuns({ operatorCode: code, limit: 1 })[0];
      if (!run) throw error;
    }
    const after = countOperatorExceedances(code);
    runs.push(run);
    if (!options.json) {
      printOperatorResult(code, run, Math.max(0, after - before));
    }
  }

  service.stopScheduler();
  if (options.json) {
    console.log(JSON.stringify(runs, null, 2));
  } else {
    const succeeded = runs.filter((run) => run.status === 'succeeded').length;
    const failed = runs.length - succeeded;
    console.log(`${runs.length} operators, ${succeeded} succeeded, ${failed} failed`);
  }
  process.exit(runs.some((run) => run.status === 'failed') ? 1 : 0);
}

main().catch((error) => {
  service.stopScheduler();
  console.error(error.message);
  process.exit(2);
});
