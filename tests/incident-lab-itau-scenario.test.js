const fs = require('fs');
const path = require('path');
const { getScenario, listScenarios } = require('../app/services/incident-lab/scenario');

const PUBLIC_DIR = path.join(__dirname, '..', 'app', 'public');

describe('incident-lab Itaú Pix scenario', () => {
  const scenario = getScenario('itau-pix-spi-roteamento');

  test('loads alongside the flowforge scenario', () => {
    expect(scenario).not.toBeNull();
    expect(listScenarios().map((s) => s.id)).toEqual(
      expect.arrayContaining(['flowforge-scheduled-workflows', 'itau-pix-spi-roteamento']),
    );
  });

  test('runs in its own Datadog namespace against the Itaú repo', () => {
    expect(scenario.severity).toBe('SEV-1');
    expect(scenario.service).toBe('itau-pix-router');
    expect(scenario.datadog.metricPrefix).toBe('itau.pix');
    expect(scenario.repoUrl).toBe('https://github.com/COG-GTM/itau-br-security-swarm-demo');
    expect(getScenario('flowforge-scheduled-workflows').datadog.metricPrefix).toBe('flowforge');
  });

  test('Corredor is the incident commander and opens the channel', () => {
    const ic = scenario.personas.find((p) => p.id === 'ic');
    expect(ic.username).toBe('Corredor');
    expect(scenario.script[0].persona).toBe('ic');
    expect(scenario.script.find((l) => l.mentionsDevin).persona).toBe('ic');
  });

  test('every persona avatar exists on disk', () => {
    for (const persona of scenario.personas) {
      expect(fs.existsSync(path.join(PUBLIC_DIR, persona.avatar))).toBe(true);
    }
  });

  test('live replies are instructed to stay in Brazilian Portuguese', () => {
    expect(scenario.llm.guardrails).toMatch(/Brazilian Portuguese/);
  });
});
