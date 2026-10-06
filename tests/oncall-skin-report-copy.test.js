process.env.DEVIN_SLACK_USER_ID = 'U123';

const fs = require('fs');
const path = require('path');
const { BUG_CATALOG, isValidIncidentCopy } = require('../app/services/oncall');
const { ONCALL_SKINS } = require('../config/oncall-skins');

const REPORT_PAGE = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'public', 'oncall-report.html'),
  'utf8',
);
const KNOWN_TEMPLATE_IDS = new Set(
  Object.values(BUG_CATALOG).flatMap((entries) => entries.map((t) => t.id)),
);

function reportCopyDefaultKeys() {
  const block = REPORT_PAGE.match(/var COPY_DEFAULTS = \{([\s\S]*?)\n {4}\};/);
  expect(block).not.toBeNull();
  return new Set(
    [...block[1].matchAll(/^\s{6}([A-Za-z]+):/gm)].map((m) => m[1]),
  );
}

describe('4875267e bug-report portal (Japanese)', () => {
  const skin = ONCALL_SKINS['4875267e'];

  test('opts in with templates that map to real hightech catalog ids', () => {
    expect(skin.bugPortal).toBeDefined();
    expect(skin.bugPortal.products.length).toBeGreaterThan(0);
    for (const product of skin.bugPortal.products) {
      expect(product.persona.name).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      for (const template of product.templates) {
        expect(KNOWN_TEMPLATE_IDS.has(template.id)).toBe(true);
        expect(template.label).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
        expect(template.text).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
        // Customer voice only: never a hint of the degradation's cause.
        expect(template.text).not.toMatch(/memory|RSS|cache|leak|メモリ|キャッシュ|リーク/i);
      }
    }
  });

  test('localizes every shared portal UI string via bugPortal.copy', () => {
    const copy = skin.bugPortal.copy;
    expect(isValidIncidentCopy(copy)).toBe(true);
    expect(copy.lang).toBe('ja');
    expect(copy.submitButton).toBe('報告を送信');
    expect(copy.asideTipStatus).toContain('{link}');
    expect(copy.submittedSkippedActivated).toContain('{minutes}');

    const defaults = reportCopyDefaultKeys();
    expect(defaults.size).toBeGreaterThan(40);
    // Every override targets a real key, and every key is overridden so no
    // English chrome leaks around the Japanese story.
    for (const key of Object.keys(copy)) expect(defaults.has(key)).toBe(true);
    for (const key of defaults) expect(typeof copy[key]).toBe('string');
  });

  test('other bug-portal skins keep the English defaults', () => {
    // Skins that deliberately localize the shared portal (each covered by its
    // own test file); every other bug-portal skin must stay on the defaults.
    const LOCALIZED = new Set(['4875267e', '059b9215']);
    const others = Object.values(ONCALL_SKINS).filter(
      (s) => s.bugPortal && !LOCALIZED.has(s.slug),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) expect(other.bugPortal.copy).toBeUndefined();
  });
});
