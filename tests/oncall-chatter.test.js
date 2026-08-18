process.env.DEVIN_SLACK_USER_ID = 'U123';

const {
  buildSev1Chatter,
  buildSev1IncidentCopy,
  replaceChatterVocabulary,
  getSev1ChatterVocabulary,
  SEV1_INCIDENTS,
} = require('../app/services/oncall');
const { ONCALL_SKINS } = require('../config/oncall-skins');

describe('SEV-1 persona chatter vocabulary', () => {
  const story = SEV1_INCIDENTS['banking-transfers'];
  const skin = ONCALL_SKINS['e7c9dc7a'];

  test('applies the DoorDash vocabulary with longest phrases first', () => {
    const vocabulary = getSev1ChatterVocabulary(story, skin, 'banking-transfers');
    const script = buildSev1Chatter(story, vocabulary);
    const text = script.map((line) => line.text).join('\n');

    expect(text).toContain('Fast Pay cash outs');
    expect(text).toContain('Dashers');
    expect(text).toContain('the payout processor');
    expect(text).toContain('cash out path');
    expect(text).not.toContain('the gateway');
    expect(text).not.toContain('Fast Pay cash out path');
  });

  test('leaves the generic script unchanged without vocabulary', () => {
    const script = buildSev1Chatter(story);

    expect(script[0].text).toBe(
      'Three enterprise customers on the phone already — transfers eventually go through, but they sit ~10 seconds on a spinner first. No errors, just slow.',
    );
  });

  test('does not mutate shared script state between builds', () => {
    const genericBefore = buildSev1Chatter(story).map((line) => line.text);
    buildSev1Chatter(
      story,
      getSev1ChatterVocabulary(story, skin, 'banking-transfers'),
    );
    const genericAfter = buildSev1Chatter(story).map((line) => line.text);

    expect(genericAfter).toEqual(genericBefore);
  });

  test('preserves mention-bearing lines, flags, and truthful endpoint text', () => {
    const script = buildSev1Chatter(
      story,
      getSev1ChatterVocabulary(story, skin, 'banking-transfers'),
    );
    const mentionLines = script.filter((line) => line.mustPost);
    const endpointLine = script.find((line) => line.text.includes('banking-api'));

    expect(mentionLines.length).toBeGreaterThan(0);
    mentionLines.forEach((line) => {
      expect(line.mustPost).toBe(true);
      expect(line.text).toContain('<@U123>');
    });
    expect(endpointLine.text).toContain('`POST /api/oncall/banking/transfer`');
  });

  test('falls back to generic chatter for a vertical mismatch', () => {
    const mismatchedSkin = {
      ...skin,
      vertical: 'insurance',
    };
    const vocabulary = getSev1ChatterVocabulary(
      story,
      mismatchedSkin,
      'banking-transfers',
    );

    expect(vocabulary).toBeNull();
    expect(buildSev1Chatter(story, vocabulary).map((line) => line.text))
      .toEqual(buildSev1Chatter(story).map((line) => line.text));
  });

  test('ignores malformed vocabulary without changing generic chatter', () => {
    const generic = buildSev1Chatter(story).map((line) => line.text);
    const malformed = [
      'not a vocabulary',
      ['transfer', 'cash out'],
      { transfer: 42 },
    ];

    malformed.forEach((vocabulary) => {
      expect(buildSev1Chatter(story, vocabulary).map((line) => line.text))
        .toEqual(generic);
    });
  });

  test('does not replace inflected words', () => {
    const text = replaceChatterVocabulary(
      'transferred transfers transfer',
      { transfer: 'cash out' },
    );

    expect(text).toBe('transferred transfers cash out');
    expect(text).not.toContain('cash outred');
  });

  test('does not substitute text inserted by another vocabulary rule', () => {
    const text = replaceChatterVocabulary(
      'transfers transfer',
      { transfers: 'cash outs', 'cash out': 'payout', transfer: 'cash out' },
    );

    expect(text).toBe('cash outs cash out');
  });

  test('removes generic banking terms without changing intentional vocabulary', () => {
    const script = buildSev1Chatter(
      story,
      getSev1ChatterVocabulary(story, skin, 'banking-transfers'),
    );
    const text = script.map((line) => line.text.replace(/`[^`]*`/g, '')).join('\n');

    expect(text).not.toMatch(/\btransfers\b/);
    expect(text).not.toMatch(/\btransfer\b/);
    expect(text).not.toMatch(/\bcustomers\b/);
    expect(text).not.toContain('the gateway');
    expect(text).toContain('Transfer completed');
    expect(text).toContain('premium-tier accounts');
  });

  test('falls back to generic chatter when the skin incident kind differs', () => {
    const mismatchedSkin = {
      ...skin,
      incident: {
        ...skin.incident,
        kind: 'other-banking-story',
      },
    };
    const vocabulary = getSev1ChatterVocabulary(
      story,
      mismatchedSkin,
      'banking-transfers',
    );

    expect(vocabulary).toBeNull();
    expect(buildSev1Chatter(story, vocabulary).map((line) => line.text))
      .toEqual(buildSev1Chatter(story).map((line) => line.text));
  });

  test('applies vocabulary to declared incident copy without mutating the story', () => {
    const original = {
      title: story.title,
      summary: story.summary,
      label: story.label,
    };
    const vocabulary = getSev1ChatterVocabulary(story, skin, 'banking-transfers');
    const copy = buildSev1IncidentCopy(story, vocabulary);

    expect(copy.title).toBe(
      'Fast Pay cash outs degraded — p95 latency 10x baseline on banking-api',
    );
    expect(copy.label).toBe(
      'Fast Pay cash outs degraded — banking-api p95 10x baseline',
    );
    expect(copy.summary).toBe(
      'POST /api/oncall/banking/transfer p95 at ~9.6s against a ~280ms baseline. Fast Pay cash outs eventually succeed but every submission hangs ~10s; support reports rising complaint volume.',
    );
    expect(copy.title).not.toMatch(/\b(?:transfers|Transfers)\b/);
    expect(copy.label).not.toMatch(/\b(?:transfers|Transfers)\b/);
    expect(copy.summary).not.toMatch(/\b(?:transfers|Transfers)\b/);
    expect(story.title).toBe(original.title);
    expect(story.summary).toBe(original.summary);
    expect(story.label).toBe(original.label);
  });

  test('leaves declared incident copy unchanged without vocabulary', () => {
    const copy = buildSev1IncidentCopy(story);

    expect(copy).toEqual({
      title: story.title,
      summary: story.summary,
      label: story.label,
    });
  });
});
