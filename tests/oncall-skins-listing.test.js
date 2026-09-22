const { ONCALL_SKINS, listOncallSkins } = require('../config/oncall-skins');

describe('on-call hub skin listing', () => {
  test('only skins that opt in with listed: true are surfaced', () => {
    const listed = listOncallSkins();
    const optedIn = Object.values(ONCALL_SKINS).filter((s) => s.listed === true);
    expect(listed.map((s) => s.slug).sort()).toEqual(optedIn.map((s) => s.slug).sort());
    expect(listed.length).toBeLessThan(Object.keys(ONCALL_SKINS).length);
  });

  test('the marketplace skin is listed and links to its branded page', () => {
    const entry = listOncallSkins().find((s) => s.slug === '63dbb52f');
    expect(entry).toMatchObject({
      company: 'Kaufland',
      vertical: 'marketplace',
      href: '/oncall/c/63dbb52f',
    });
  });

  test('listing exposes only hub-card fields, never portal or page internals', () => {
    for (const entry of listOncallSkins()) {
      expect(Object.keys(entry).sort()).toEqual(
        ['accent', 'brandMark', 'company', 'href', 'slug', 'vertical'],
      );
    }
  });
});
