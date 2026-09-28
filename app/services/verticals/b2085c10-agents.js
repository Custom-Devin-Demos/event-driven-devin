const { TYPE_RULES } = require('./b2085c10-type-rules');

/**
 * Migration subagents dispatched by the cockpit orchestrator for each table:
 *
 *   schema-mapper-03    Teradata DDL → Delta column plan (TYPE_RULES)
 *   data-validator-01   lineage check: every source column lands in Delta
 *
 * A subagent that cannot proceed without a human decision raises an
 * AgentEscalation carrying the question it needs answered.
 */

const SCHEMA_MAPPER = 'schema-mapper-03';
const DATA_VALIDATOR = 'data-validator-01';

class AgentEscalation extends Error {
  constructor(agent, message, details = {}) {
    super(message);
    this.name = 'AgentEscalation';
    this.agent = agent;
    this.code = 'AGENT_INPUT_REQUIRED';
    this.statusCode = 409;
    this.details = details;
  }
}

function typeSignature(tdType) {
  return tdType.toUpperCase().replace(/\s*\([^)]*\)/g, '').trim();
}

function typeArgs(tdType) {
  const match = /\(([^)]*)\)/.exec(tdType);
  return match ? `(${match[1].replace(/\s+/g, '')})` : '';
}

function mapColumn(column) {
  const rule = TYPE_RULES[typeSignature(column.type)];
  if (!rule) return null;
  const target = rule.keepArgs ? `${rule.target}${typeArgs(column.type)}` : rule.target;
  return {
    source: column.name,
    name: column.name.toLowerCase(),
    type: target.toLowerCase(),
    nullable: column.nullable,
  };
}

function planTable(table, wave) {
  const columns = [];
  for (const column of table.columns) {
    const mapped = mapColumn(column);
    if (!mapped) {
      const fqn = `${table.database}.${table.name}.${column.name}`;
      throw new AgentEscalation(
        SCHEMA_MAPPER,
        `${SCHEMA_MAPPER} needs input to continue wave ${wave.id.slice(1)}: `
          + `${fqn} is Teradata ${column.type} and has no approved Delta mapping. `
          + `Split it into ${column.name}_START / ${column.name}_END columns, land it as a STRUCT, or keep it as STRING?`,
        {
          table: `${table.database}.${table.name}`,
          column: column.name,
          sourceType: column.type,
          options: ['split', 'struct', 'string'],
        },
      );
    }
    columns.push(mapped);
  }
  return {
    table: `nord_prod.${table.database.toLowerCase()}.${table.name.toLowerCase()}`,
    source: `${table.database}.${table.name}`,
    columns,
  };
}

function validateLineage(table, plan) {
  const landed = new Set(plan.columns.map((column) => column.name));
  const missing = table.columns
    .map((column) => column.name)
    .filter((name) => !landed.has(name.toLowerCase()));
  if (missing.length) {
    throw new AgentEscalation(
      DATA_VALIDATOR,
      `${DATA_VALIDATOR} blocked ${plan.source}: source columns ${missing.join(', ')} have no lineage in ${plan.table}. Approve the column plan before load?`,
      { table: plan.source, missing },
    );
  }
  return { table: plan.table, columns: plan.columns.length, lineage: 'complete' };
}

function renderDeltaDdl(plan) {
  const cols = plan.columns
    .map((column) => `  ${column.name} ${column.type.toUpperCase()}${column.nullable ? '' : ' NOT NULL'}`)
    .join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${plan.table} (\n${cols}\n) USING DELTA`;
}

module.exports = {
  AgentEscalation,
  SCHEMA_MAPPER,
  DATA_VALIDATOR,
  planTable,
  validateLineage,
  renderDeltaDdl,
};
