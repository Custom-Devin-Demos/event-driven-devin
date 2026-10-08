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

describe('on-call skin session prompt Slack thread context', () => {
  const THREAD = { channel: 'C0ALERTS', threadTs: '1791473000.000100' };

  test('appends the Slack Thread line when channel and thread_ts are known', () => {
    const prompt = buildOncallSessionPrompt(SCENARIO, SKIN, 'run-1', THREAD);

    expect(prompt).toContain('\n\n*Slack Thread:* channel=C0ALERTS thread_ts=1791473000.000100');
    expect(prompt).not.toContain('Progress updates for the on-call engineer');
  });

  test('omits thread context entirely without a thread', () => {
    expect(buildOncallSessionPrompt(SCENARIO, SKIN, 'run-1')).not.toContain('*Slack Thread:*');
    expect(buildOncallSessionPrompt(SCENARIO, SKIN, 'run-1', { channel: 'C0ALERTS' })).not.toContain('*Slack Thread:*');
  });

  test('adds the notify paragraph for the Ambrook skin', () => {
    const { ONCALL_SKINS } = require('../config/oncall-skins');
    const ambrook = ONCALL_SKINS.d51a1791;

    expect(ambrook.devinSession).toEqual({ auto: true, notifySlackMemberId: 'U0B7F46NVA4' });
    expect(ambrook.teamsAlerts).toBeUndefined();

    const prompt = buildOncallSessionPrompt(SCENARIO, ambrook, 'run-2', THREAD);
    expect(prompt).toContain('*Slack Thread:* channel=C0ALERTS thread_ts=1791473000.000100');
    expect(prompt).toContain('(1) as soon as the root cause is confirmed, post <@U0B7F46NVA4>');
    expect(prompt).toContain('(2) as soon as the fix PR is open, post <@U0B7F46NVA4>');
    expect(prompt).toContain('"channel":"C0ALERTS","thread_ts":"1791473000.000100"');
    expect(prompt).toContain('$SLACK_ONCALL_BOT_TOKEN');
    expect(prompt).toContain('$COG_GTM_DEMO_SLACK_BOT_TOKEN');
  });

  test('does not add the notify paragraph without a thread or with an invalid member id', () => {
    const skin = { ...SKIN, devinSession: { auto: true, notifySlackMemberId: 'U0B7F46NVA4' } };
    expect(buildOncallSessionPrompt(SCENARIO, skin, 'run-3')).not.toContain('<@U0B7F46NVA4>');

    const bad = { ...SKIN, devinSession: { auto: true, notifySlackMemberId: '<@not valid>' } };
    const prompt = buildOncallSessionPrompt(SCENARIO, bad, 'run-3', THREAD);
    expect(prompt).toContain('*Slack Thread:*');
    expect(prompt).not.toContain('Progress updates for the on-call engineer');
  });

  test('keeps the appendix before the thread context', () => {
    const skin = { ...SKIN, devinSession: { promptAppendix: 'Appendix text.' } };
    const prompt = buildOncallSessionPrompt(SCENARIO, skin, 'run-4', THREAD);
    expect(prompt.indexOf('Appendix text.')).toBeLessThan(prompt.indexOf('*Slack Thread:*'));
  });
});
