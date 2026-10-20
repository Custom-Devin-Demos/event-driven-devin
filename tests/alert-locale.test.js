/* global describe, expect, test */

const { buildAlertBlocks, onCallText } = require('../app/services/slack');
const { buildPrompt } = require('../app/services/devin-session');
const { alertLocale } = require('../app/services/alert-locale');

const BASE = {
  issueTitle: "TypeError: Cannot read properties of undefined (reading 'carpeta')",
  errorType: 'TypeError',
  errorValue: "Cannot read properties of undefined (reading 'carpeta')",
  culprit: 'app/services/verticals/bccr.js — descargarPublicacion',
  level: 'error',
  service: 'bccr-publicaciones-sector-real',
  verticalLabel: 'BCCR — Descarga de publicaciones Sector Real',
  issueUrl: 'https://sentry.example/issues/1',
  slackMemberId: 'U08S7AVJ478',
  tags: [{ key: 'route', value: '/api/bccr/descargas' }],
};

const card = (alertData, opts) => JSON.stringify(buildAlertBlocks(alertData, opts));

describe('alert locale', () => {
  test('defaults to English and honours the customer config locale', () => {
    expect(alertLocale({})).toBe('en');
    expect(alertLocale({ customerConfig: { locale: 'es' } })).toBe('es');
    expect(alertLocale({ customerConfig: { locale: 'xx' } })).toBe('en');
  });

  test('Spanish customers get a Spanish Slack alert card with the clicking user On-Call', () => {
    const text = card({ ...BASE, customerConfig: { locale: 'es' } }, { includeDevinOnCall: false });
    expect(text).toContain('Alerta de Sentry — Error en BCCR');
    expect(text).toContain('*Severidad:*');
    expect(text).toContain('*Ubicación:*');
    expect(text).toContain('*Mensaje:*');
    expect(text).toContain('*Guardia:*\\n<@U08S7AVJ478>');
    expect(text).toContain('Ver en Sentry');
    expect(text).not.toContain('On-Call');
  });

  test('Spanish card says Sin asignar when nobody resolves', () => {
    const text = card({ ...BASE, slackMemberId: '', customerConfig: { locale: 'es' } }, { includeDevinOnCall: false });
    expect(text).toContain('_Sin asignar_');
  });

  test('other customers keep the English card', () => {
    const text = card({ ...BASE, customerConfig: { locale: 'en' } }, { includeDevinOnCall: false });
    expect(text).toContain('Sentry Alert — BCCR');
    expect(text).toContain('*On-Call:*');
    expect(onCallText('')).toBe('_Unassigned_');
  });

  test('Spanish prompt labels and language directive; English prompt unchanged', () => {
    const es = buildPrompt({ ...BASE, customerConfig: { locale: 'es' } });
    expect(es).toContain('*Ubicación:*');
    expect(es).toContain('*Etiquetas:*');
    expect(es).toContain('responde en español');

    const en = buildPrompt(BASE);
    expect(en).toContain('*Location:*');
    expect(en).not.toContain('español');
  });
});

describe('alert locale — Japanese', () => {
  const JA = {
    ...BASE,
    culprit: 'app/services/verticals/4875267e.js — registerAttendee',
    service: 'event-registration-api',
    verticalLabel: 'イベント参加登録',
    locale: 'ja',
  };

  test('an alert tagged locale ja gets a Japanese Slack card', () => {
    expect(alertLocale(JA)).toBe('ja');
    const text = card(JA, { includeDevinOnCall: false });
    expect(text).toContain('Sentryアラート — イベント参加登録エラー');
    expect(text).toContain('*重大度:*');
    expect(text).toContain('*発生箇所:*');
    expect(text).toContain('*オンコール担当:*\\n<@U08S7AVJ478>');
    expect(text).toContain('Sentryで表示');
    expect(text).not.toContain('Severity');
  });

  test('the Devin prompt asks for Japanese replies; English alerts do not', () => {
    expect(buildPrompt({ ...JA, customerConfig: {} })).toContain('日本語で回答してください');
    expect(buildPrompt({ ...BASE, customerConfig: {} })).not.toContain('日本語');
  });
});
