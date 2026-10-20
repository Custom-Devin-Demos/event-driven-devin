// Alert copy for the Slack/Teams cards and the Devin prompt. A customer opts in
// with `locale` in config/customers/<slug>.js; everything else stays English.
const STRINGS = {
  en: {
    header: (label) => `Sentry Alert — ${label} Error`,
    titleSeparator: ' — ',
    defaultLabel: 'Checkout',
    error: 'Error',
    severity: 'Severity',
    location: 'Location',
    type: 'Type',
    message: 'Message',
    release: 'Release',
    environment: 'Environment',
    onCall: 'On-Call',
    devinOnCall: 'Devin AI (auto-investigating)',
    unassigned: '_Unassigned_',
    viewSentry: 'View in Sentry',
    viewDatadog: 'View in Datadog',
    watchDevin: 'Watch Devin',
    triggeredBy: 'Triggered by',
    service: 'Service',
    unknown: 'unknown',
    level: 'Level',
    sentryIssue: 'Sentry Issue',
    devinInvestigating: 'Devin is investigating this issue.',
    devinInvestigatingShort: 'Devin is investigating',
    viewInDevin: 'View in Devin',
    project: 'Project',
    env: 'Env',
    events: 'Events',
    first: 'First',
    last: 'Last',
    rule: 'Rule',
    tags: 'Tags',
    promptLanguage: null,
  },
  es: {
    header: (label) => `Alerta de Sentry — Error en ${label}`,
    titleSeparator: ' — ',
    defaultLabel: 'Checkout',
    error: 'Error',
    severity: 'Severidad',
    location: 'Ubicación',
    type: 'Tipo',
    message: 'Mensaje',
    release: 'Versión',
    environment: 'Entorno',
    onCall: 'Guardia',
    devinOnCall: 'Devin AI (investigando automáticamente)',
    unassigned: '_Sin asignar_',
    viewSentry: 'Ver en Sentry',
    viewDatadog: 'Ver en Datadog',
    watchDevin: 'Ver a Devin',
    triggeredBy: 'Activado por',
    service: 'Servicio',
    unknown: 'desconocido',
    level: 'Nivel',
    sentryIssue: 'Issue de Sentry',
    devinInvestigating: 'Devin está investigando este problema.',
    devinInvestigatingShort: 'Devin está investigando',
    viewInDevin: 'Ver en Devin',
    project: 'Proyecto',
    env: 'Entorno',
    events: 'Eventos',
    first: 'Primero',
    last: 'Último',
    rule: 'Regla',
    tags: 'Etiquetas',
    promptLanguage: '*Idioma:* responde en español — mensajes en el hilo de Slack, título y descripción del PR, y resumen final.',
  },
  ja: {
    header: (label) => `Sentryアラート — ${label}エラー`,
    titleSeparator: ' — ',
    defaultLabel: 'チェックアウト',
    error: 'エラー',
    severity: '重大度',
    location: '発生箇所',
    type: '種別',
    message: 'メッセージ',
    release: 'リリース',
    environment: '環境',
    onCall: 'オンコール担当',
    devinOnCall: 'Devin AI（自動調査中）',
    unassigned: '_未割り当て_',
    viewSentry: 'Sentryで表示',
    viewDatadog: 'Datadogで表示',
    watchDevin: 'Devinを表示',
    triggeredBy: '発報者',
    service: 'サービス',
    unknown: '不明',
    level: 'レベル',
    sentryIssue: 'Sentry Issue',
    devinInvestigating: 'Devinがこの問題を調査中です。',
    devinInvestigatingShort: 'Devinが調査中です',
    viewInDevin: 'Devinで表示',
    project: 'プロジェクト',
    env: '環境',
    events: 'イベント数',
    first: '初回',
    last: '最終',
    rule: 'ルール',
    tags: 'タグ',
    promptLanguage: '*言語:* 日本語で回答してください — Slackスレッドへの返信、PRのタイトルと説明、最終サマリーはすべて日本語で書いてください。',
  },
};

// English without typographic dashes, for customers whose cards must avoid em dashes.
STRINGS['en-plain'] = {
  ...STRINGS.en,
  header: (label) => `Sentry Alert: ${label} error`,
  titleSeparator: ' | ',
};

function alertLocale(alertData) {
  const locale = alertData && (alertData.locale || (alertData.customerConfig && alertData.customerConfig.locale));
  return Object.prototype.hasOwnProperty.call(STRINGS, locale) ? locale : 'en';
}

function alertStrings(alertDataOrLocale) {
  if (typeof alertDataOrLocale === 'string') {
    return STRINGS[alertDataOrLocale] || STRINGS.en;
  }
  return STRINGS[alertLocale(alertDataOrLocale)];
}

module.exports = { STRINGS, alertLocale, alertStrings };
