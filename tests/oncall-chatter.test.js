process.env.DEVIN_SLACK_USER_ID = 'U123';

const {
  buildSev1Chatter,
  replaceChatterVocabulary,
  getSev1ChatterVocabulary,
  SEV1_INCIDENTS,
} = require('../app/services/oncall');
const { ONCALL_SKINS } = require('../config/oncall-skins');

describe('SEV-1 persona chatter vocabulary', () => {
  const story = SEV1_INCIDENTS['banking-transfers'];
  const skin = ONCALL_SKINS['e7c9dc7a'];

  test('applies the DoorDash vocabulary with longest phrases first', () => {
    const vocabulary = getSev1ChatterVocabulary(story, skin);
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
    buildSev1Chatter(story, getSev1ChatterVocabulary(story, skin));
    const genericAfter = buildSev1Chatter(story).map((line) => line.text);

    expect(genericAfter).toEqual(genericBefore);
  });

  test('preserves mention-bearing lines, flags, and truthful endpoint text', () => {
    const script = buildSev1Chatter(story, getSev1ChatterVocabulary(story, skin));
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
    const vocabulary = getSev1ChatterVocabulary(story, mismatchedSkin);

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
});
