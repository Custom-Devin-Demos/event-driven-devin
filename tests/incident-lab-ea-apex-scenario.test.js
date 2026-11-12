const fs = require('fs');
const path = require('path');
const { getScenario, listScenarios } = require('../app/services/incident-lab/scenario');

const PUBLIC_DIR = path.join(__dirname, '..', 'app', 'public');

describe('incident-lab EA Apex Coins receipt replay scenario', () => {
  const scenario = getScenario('ea-apex-coins-receipt-replay');
  const phase = (id) => scenario.datadog.phases.find((p) => p.id === id);

  test('loads alongside the existing scenarios', () => {
    expect(scenario).not.toBeNull();
    expect(listScenarios().map((s) => s.id)).toEqual(
      expect.arrayContaining(['flowforge-scheduled-workflows', 'itau-pix-spi-roteamento', 'ea-apex-coins-receipt-replay']),
    );
  });

  test('runs in its own Datadog namespace against the EA subject repo', () => {
    expect(scenario.severity).toBe('SEV-1');
    expect(scenario.service).toBe('apex-entitlements');
    expect(scenario.datadog.metricPrefix).toBe('apex.entitlements');
    expect(scenario.repoUrl).toBe('https://github.com/COG-GTM/ea-oncall-demo');
  });

  test('Rhea is the incident commander and opens the channel', () => {
    const ic = scenario.personas.find((p) => p.id === 'ic');
    expect(ic.username).toBe('Rhea Castellanos');
    expect(scenario.script[0].persona).toBe('ic');
    expect(scenario.script.find((l) => l.mentionsDevin).persona).toBe('ic');
  });

  test('every persona avatar exists on disk', () => {
    for (const persona of scenario.personas) {
      expect(fs.existsSync(path.join(PUBLIC_DIR, persona.avatar))).toBe(true);
    }
  });

  test('the bot farm is loud but blocking it is a no-op for the coin surplus', () => {
    const block = scenario.mitigations.options.find((o) => o.id === 'block-bot-asn');
    expect(block.action).toBe('asn-blocked');
    const blocked = phase('asn-blocked');
    expect(blocked.manual).toBe(true);
    expect(blocked.metrics.some((m) => m.metric === 'wallet.coins.credited')).toBe(false);
    expect(phase('bot-farm').startMs).toBeGreaterThan(phase('onset').startMs);
  });

  test('outage-era logs never warn about the replays; only the old build did', () => {
    const outage = ['onset', 'escalation'].flatMap((id) => phase(id).logs);
    expect(outage.every((l) => l.status === 'info')).toBe(true);
    expect(outage.some((l) => /duplicate/.test(l.template))).toBe(false);
    const probe = scenario.datadog.prelude[0];
    expect(probe.backdateMs).toBeGreaterThan(-phase('deploy').startMs);
    expect(probe.logs.every((l) => l.template.startsWith('duplicate redemption rejected: xbox order '))).toBe(true);
  });

  test('root-cause beats stay late', () => {
    const unlockOf = (re) => Math.min(...scenario.knowledge.filter((k) => k.facts.some((f) => re.test(f))).map((k) => k.unlockAtMs));
    for (const clue of [/envelope/, /not one has been credited/]) {
      const at = unlockOf(clue);
      expect(Number.isFinite(at)).toBe(true);
      expect(at).toBeGreaterThanOrEqual(600000);
    }
    expect(scenario.llm.guardrails).toMatch(/Never reveal the root cause/);
  });
});
