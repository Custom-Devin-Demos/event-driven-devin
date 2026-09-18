const {
  buildOncallSessionPrompt,
} = require('../app/services/oncall');

const SCENARIO = {
  service: 'telco-api',
  monitor: 'Plan upgrade latency',
  metricQuery: 'avg:telco.upgrade.latency',
  endpoint: 'POST /api/telco/upgrade',
  metricValue: '7.4',
  threshold: '5',
  baseline: '1.2',
  release: 'telco@1.0.0',
  symptom: 'Plan upgrades are slow',
  impact: 'Customers wait for plan changes',
};

const SKIN = { slug: 'demo' };

describe('on-call skin session prompt appendix', () => {
  test('keeps the prompt unchanged when no appendix is configured', () => {
    const prompt = buildOncallSessionPrompt(SCENARIO, SKIN, '');

    expect(prompt).toBe([
      'A Datadog monitor is firing on telco-api. Investigate it and open a PR with the fix.',
      '',
      '*Monitor:* Plan upgrade latency — Triggered',
      '*Query:* `avg:telco.upgrade.latency`',
      '*Endpoint:* POST /api/telco/upgrade',
      '*Metric value:* 7.4 (threshold 5, baseline 1.2)',
      '*Release:* telco@1.0.0',
      '*Symptom:* Plan upgrades are slow',
      '*Impact:* Customers wait for plan changes',
      '',
      'Reproduce the symptom at https://devindemos.com/oncall/c/demo and diagnose it from the repository and its telemetry: https://github.com/COG-GTM/event-driven-devin',
    ].join('\n'));
  });

  test('appends a configured appendix after the prompt', () => {
    const appendix = 'Capture the before and after states.';
    const prompt = buildOncallSessionPrompt(
      SCENARIO,
      { ...SKIN, devinSession: { promptAppendix: appendix } },
      'run-123',
    );

    expect(prompt.endsWith(`\n\n${appendix}`)).toBe(true);
  });
});
