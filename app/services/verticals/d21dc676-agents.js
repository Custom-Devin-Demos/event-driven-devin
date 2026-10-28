const D = require('./d21dc676-decimal');
const { PIC_RULES, ROUNDING, PARITY } = require('./d21dc676-conversion-rules');

/**
 * Migration subagents the cockpit orchestrator dispatches for a batch job:
 *
 *   cobol-analyst-01     parse the procedure division into statements
 *   java-translator-02   COBOL statements → Spring Batch processor plan
 *   mockdata-gen-01      schema-driven focus-file rows (no SQL access)
 *   parity-verifier-01   legacy output vs Java output, column by column
 *
 * A subagent that cannot proceed without a human decision raises an
 * AgentEscalation carrying the question it needs answered.
 */

const COBOL_ANALYST = 'cobol-analyst-01';
const JAVA_TRANSLATOR = 'java-translator-02';
const MOCKDATA_GEN = 'mockdata-gen-01';
const PARITY_VERIFIER = 'parity-verifier-01';

const JAVA_DEFAULT_ROUNDING = 'HALF_EVEN';

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

function countNines(part) {
  return part.replace(/9\((\d+)\)/g, (_, n) => '9'.repeat(Number(n))).replace(/[^9]/g, '').length;
}

function picClass(field) {
  const pic = field.pic.toUpperCase();
  if (/^X/.test(pic)) {
    const length = /X\((\d+)\)/.exec(pic);
    return { cls: 'ALPHANUMERIC', length: length ? Number(length[1]) : pic.length };
  }
  const signed = pic.startsWith('S');
  const [intPart, fracPart = ''] = pic.replace(/^S/, '').split('V');
  const precision = countNines(intPart) + countNines(fracPart);
  const scale = countNines(fracPart);
  if (/-DT$/.test(field.name) && precision === 8 && !scale) return { cls: 'DATE_CCYYMMDD', precision, scale };
  if (field.usage === 'COMP-3') return { cls: 'PACKED_DECIMAL', precision, scale };
  if (scale) return { cls: signed ? 'SIGNED_DECIMAL' : 'UNSIGNED_DECIMAL', precision, scale };
  return { cls: signed ? 'SIGNED_INTEGER' : 'UNSIGNED_INTEGER', precision, scale };
}

function baseName(cobolName) {
  return cobolName.replace(/^[A-Z]{2}-/, '').toLowerCase();
}

function javaName(cobolName) {
  return baseName(cobolName).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function columnName(cobolName) {
  return baseName(cobolName).replace(/-/g, '_');
}

function mapField(field) {
  const pic = picClass(field);
  const rule = PIC_RULES[pic.cls];
  let aurora = rule.aurora;
  if (rule.keepLength) aurora = `${aurora}(${pic.length})`;
  if (rule.keepPrecision) aurora = `${aurora}(${pic.precision},${pic.scale})`;
  return {
    source: field.name,
    pic: `PIC ${field.pic}${field.usage ? ` ${field.usage}` : ''}`,
    picClass: pic.cls,
    scale: pic.scale || 0,
    column: columnName(field.name),
    javaField: javaName(field.name),
    javaType: rule.java,
    auroraType: aurora,
  };
}

function analyzeCobol(sourceLines) {
  const text = sourceLines.map((line) => line.trim()).join(' ');
  return text
    .split(/\.\s+|\.$/)
    .map((stmt) => stmt.replace(/\s+/g, ' ').trim())
    .filter((stmt) => /^(MOVE|COMPUTE)\b/.test(stmt))
    .map((stmt) => ({ kind: stmt.split(' ')[0], text: stmt }));
}

function translateStatement(stmt, targets) {
  if (stmt.kind === 'MOVE') {
    const [, from, to] = /^MOVE\s+([A-Z0-9-]+)\s+TO\s+([A-Z0-9-]+)$/.exec(stmt.text);
    return { kind: 'move', from, to };
  }
  const match = /^COMPUTE\s+([A-Z0-9-]+)(\s+ROUNDED)?\s*=\s*([A-Z0-9-]+)\s*([-+*])\s*([A-Z0-9-]+)$/.exec(stmt.text);
  if (!match) {
    throw new AgentEscalation(JAVA_TRANSLATOR, `${JAVA_TRANSLATOR} cannot translate "${stmt.text}".`, { statement: stmt.text });
  }
  const target = targets[match[1]];
  const phrase = match[2] || 'TRUNCATED';
  return {
    kind: 'compute',
    target: match[1],
    left: match[3],
    op: match[4],
    right: match[5],
    scale: target.scale,
    rounding: ROUNDING[phrase] || JAVA_DEFAULT_ROUNDING,
    cobol: stmt.text,
  };
}

function translateProgram(statements, outputCopybook) {
  const targets = Object.fromEntries(outputCopybook.fields.map((field) => [field.name, mapField(field)]));
  return statements.map((stmt) => translateStatement(stmt, targets));
}

const OPS = { '+': D.add, '-': D.subtract, '*': D.multiply };

function executePlan(plan, lots, context) {
  return lots.map((fl) => {
    const values = { ...fl, ...context };
    const out = {};
    plan.forEach((step) => {
      if (step.kind === 'move') {
        values[step.to] = values[step.from];
        out[step.to] = values[step.from];
        return;
      }
      const result = D.setScale(OPS[step.op](D.parse(values[step.left]), D.parse(values[step.right])), step.scale, step.rounding);
      values[step.target] = D.format(result);
      out[step.target] = values[step.target];
    });
    return out;
  });
}

function verifyParity({ job, legacyRows, javaRows, outputCopybook }) {
  const keyOf = (row) => `${row['LB-OPCO-NBR']}|${row['LB-LOT-NBR']}`;
  const javaByKey = new Map(javaRows.map((row) => [keyOf(row), row]));
  const compared = outputCopybook.fields.map((field) => field.name);
  const breaks = [];
  legacyRows.forEach((legacy) => {
    const java = javaByKey.get(keyOf(legacy)) || {};
    compared.forEach((name) => {
      const a = legacy[name];
      const b = java[name];
      const field = outputCopybook.fields.find((f) => f.name === name);
      const numeric = field.usage === 'COMP-3';
      const same = numeric && b !== undefined ? D.equals(D.parse(a), D.parse(b)) : a === b;
      if (!same) {
        breaks.push({
          opco: legacy['LB-OPCO-NBR'],
          lot: legacy['LB-LOT-NBR'],
          item: legacy['LB-ITEM-NBR'],
          field: name,
          column: columnName(name),
          legacy: a,
          java: b === undefined ? null : b,
          delta: numeric && b !== undefined ? D.format(D.subtract(D.parse(b), D.parse(a))) : null,
        });
      }
    });
  });

  const cells = legacyRows.length * compared.length;
  if (breaks.length) {
    const first = breaks[0];
    const rows = new Set(breaks.map((b) => b.lot)).size;
    const cols = [...new Set(breaks.map((b) => b.field))];
    throw new AgentEscalation(
      PARITY_VERIFIER,
      `${PARITY_VERIFIER} needs input to continue ${job.id} (${job.program}): ${rows} of ${legacyRows.length.toLocaleString('en-US')} lots differ from the legacy LBBAL output in ${cols.join(', ')} `
        + `(e.g. lot ${first.lot} OpCo ${first.opco}: Java ${first.java} vs COBOL ${first.legacy}). `
        + 'Accept a ±0.01 tolerance, re-baseline the legacy output to the Java result, or log it as a legacy defect?',
      {
        job: job.id,
        program: job.program,
        rowsCompared: legacyRows.length,
        cellsCompared: cells,
        mismatchedRows: rows,
        columns: cols,
        breaks: breaks.slice(0, 12),
        tolerance: PARITY.ledgerAmount,
        options: ['tolerance', 'rebaseline', 'legacy-defect'],
      },
    );
  }
  return {
    rowsCompared: legacyRows.length, columnsCompared: compared.length, cellsCompared: cells, mismatches: 0, parity: 100,
  };
}

function renderJava(plan, inputCopybook, outputCopybook) {
  const accessor = (name) => javaName(name).replace(/^./, (c) => c.toUpperCase());
  const ref = (name) => {
    if (name === 'WS-BUS-DT') return 'businessDate';
    if (name.startsWith('FL-')) return `fl.get${accessor(name)}()`;
    return `lb.get${accessor(name)}()`;
  };
  const setter = (name) => `lb.set${accessor(name)}`;
  const method = { '+': 'add', '-': 'subtract', '*': 'multiply' };
  const lines = plan.map((step) => {
    if (step.kind === 'move') return `    ${setter(step.to)}(${ref(step.from)});`;
    return `    ${setter(step.target)}(${ref(step.left)}\n        .${method[step.op]}(${ref(step.right)})\n        .setScale(${step.scale}, RoundingMode.${step.rounding}));`;
  });
  return [
    'package com.sysco.inventory.close.batch;',
    '',
    'import java.math.RoundingMode;',
    'import java.time.LocalDate;',
    'import org.springframework.batch.item.ItemProcessor;',
    'import org.springframework.stereotype.Component;',
    '',
    `// Translated from SYBAL020 2000-CALC-BEGIN-BAL (${inputCopybook.name} -> ${outputCopybook.name})`,
    '@Component',
    'public class BeginningBalanceProcessor',
    '    implements ItemProcessor<LotFocusRecord, LotBeginningBalance> {',
    '',
    '  private final LocalDate businessDate;',
    '',
    '  @Override',
    '  public LotBeginningBalance process(LotFocusRecord fl) {',
    '    LotBeginningBalance lb = new LotBeginningBalance();',
    ...lines,
    '    return lb;',
    '  }',
    '}',
  ].join('\n');
}

module.exports = {
  AgentEscalation,
  COBOL_ANALYST,
  JAVA_TRANSLATOR,
  MOCKDATA_GEN,
  PARITY_VERIFIER,
  mapField,
  analyzeCobol,
  translateProgram,
  executePlan,
  verifyParity,
  renderJava,
};
