const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { CUSTOMER, OWNER } = require('./a75ccde9');

const PAGE_FILE = path.join(__dirname, '..', '..', 'public', 'verticals', 'a75ccde9.html');
const PAGE_URL = '/oncall/c/a75ccde9';
const AUDIT_SERVICE = 'customer-a75ccde9-web-quality';
const AUDIT_PROJECT = 'event-driven-devin';
const AUDIT_RELEASE = 'a75ccde9-web@1.0.0';
const SCENARIO = 'plan-page-frontend-quality';

// Minimum contrast for body text at this size, WCAG 2.2 SC 1.4.3 (AA).
const MIN_CONTRAST = 4.5;
// Minimum pointer target, WCAG 2.2 SC 2.5.5 and the iOS/Android touch guidelines.
const MIN_TARGET_PX = 44;

const AUDIT_REMEDIATION_DIRECTIVE = [
  '*Repository to fix:* `COG-GTM/event-driven-devin`',
  '',
  'This alert comes from the nightly frontend-quality audit of the FOX One plan page',
  '(`app/public/verticals/a75ccde9.html`, served at `https://devindemos.com/oncall/c/a75ccde9`).',
  'The regression is in the promo banner markup and its CSS, not in the plan-change flow.',
  'Run the audit locally with `npm run audit:fox` — it prints every finding with the',
  'measured value, the required value and the WCAG success criterion.',
  '',
  'Steps:',
  '1. Start a screen recording before touching any code (`recording_start`), then reproduce at',
  'the live URL: run axe-core against the page in the browser and open the DevTools Lighthouse',
  'panel (mobile preset, accessibility + performance). Capture the failing axe rules and the',
  'Lighthouse accessibility score and CLS. Annotate the recording with what fails.',
  '2. Fix every finding the audit reports, at the source: real contrast ratios (not larger text),',
  'a real `<button>` with an accessible name for the icon control, pointer targets at or above',
  `${MIN_TARGET_PX}px, and intrinsic \`width\`/\`height\` plus eager loading on the above-the-fold`,
  'promo image so it stops shifting layout.',
  '3. Keep the plan-change flow working: the billing toggle, plan selection and Continue button',
  'must behave exactly as before, and the page must still look like the FOX One page.',
  '4. Re-run `npm run audit:fox` (must exit 0) and `npx jest tests/a75ccde9-quality.test.js`.',
  '5. Re-run axe-core and Lighthouse on the fixed page locally, on camera, then build a small',
  'local `scoreboard.html` showing BEFORE vs AFTER in large type — Lighthouse accessibility',
  'score, CLS, LCP and axe violation count, each with the delta — and end the recording on it',
  'for ~5 seconds. Use measured numbers only; show any metric that did not move.',
  '6. Open a pull request against `main` with the recording, the before/after Lighthouse and axe',
  'screenshots, and the audit output before and after. End the description with',
  '`Devin-Org: engineering`, post the PR link here, and stop for human approval. Do not merge.',
].join('\n');

function parseHex(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!match) return null;
  const hex = match[1].length === 3
    ? match[1].split('').map((char) => char + char).join('')
    : match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return null;
  const light = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const dark = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (light + 0.05) / (dark + 0.05);
}

function readStyleSheet(html) {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  return styles.join('\n');
}

/**
 * Declarations of a single-selector rule, e.g. `.promo-terms { color: #8C8C8C; }`.
 * Media-query and multi-selector blocks are intentionally out of scope: the audit
 * reads the base rule the banner ships with.
 */
function declarationsFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!rule) return {};
  return rule[2]
    .split(';')
    .map((declaration) => declaration.split(':'))
    .filter((parts) => parts.length >= 2)
    .reduce((props, parts) => {
      props[parts[0].trim()] = parts.slice(1).join(':').trim();
      return props;
    }, {});
}

function pixels(value) {
  const match = /^(-?[\d.]+)px$/.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

function elementByClass(html, className) {
  const pattern = new RegExp(`<([a-z][a-z0-9-]*)\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i');
  const match = pattern.exec(html);
  if (!match) return null;
  return { tag: match[1].toLowerCase(), openTag: match[0], index: match.index };
}

function attribute(openTag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(openTag);
  return match ? match[1] : null;
}

function innerText(html, element) {
  if (!element) return '';
  const rest = html.slice(element.index + element.openTag.length);
  const closing = rest.indexOf(`</${element.tag}`);
  const inner = closing === -1 ? rest : rest.slice(0, closing);
  return inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function finding(rule) {
  return {
    ruleId: rule.ruleId,
    impact: rule.impact,
    standard: rule.standard,
    selector: rule.selector,
    measured: rule.measured,
    required: rule.required,
    detail: rule.detail,
  };
}

function checkContrast(css) {
  const findings = [];
  const surfaces = [
    { selector: '.promo-terms', background: '.promo-banner', label: 'promo fine print' },
    { selector: '.promo-headline', background: '.promo-banner', label: 'promo headline' },
  ];
  for (const surface of surfaces) {
    const color = declarationsFor(css, surface.selector).color;
    const background = declarationsFor(css, surface.background).background;
    const ratio = contrastRatio(color, background);
    if (ratio === null || ratio >= MIN_CONTRAST) continue;
    findings.push(finding({
      ruleId: 'color-contrast',
      impact: 'serious',
      standard: 'WCAG 2.2 AA · 1.4.3 Contrast (Minimum)',
      selector: surface.selector,
      measured: `${ratio.toFixed(2)}:1 (${color} on ${background})`,
      required: `${MIN_CONTRAST.toFixed(1)}:1`,
      detail: `${surface.label} is unreadable for low-vision viewers`,
    }));
  }
  return findings;
}

function checkTargetSize(css) {
  const selector = '.promo-dismiss';
  const declarations = declarationsFor(css, selector);
  const width = pixels(declarations.width);
  const height = pixels(declarations.height);
  if (width === null && height === null) return [];
  const smallest = Math.min(width === null ? Infinity : width, height === null ? Infinity : height);
  if (smallest >= MIN_TARGET_PX) return [];
  return [finding({
    ruleId: 'target-size',
    impact: 'serious',
    standard: 'WCAG 2.2 AAA · 2.5.5 Target Size, iOS/Android 44px guidance',
    selector,
    measured: `${width || '?'}x${height || '?'}px`,
    required: `${MIN_TARGET_PX}x${MIN_TARGET_PX}px`,
    detail: 'dismiss control is too small to hit reliably on a phone',
  })];
}

function checkAccessibleName(html) {
  const element = elementByClass(html, 'promo-dismiss');
  if (!element) return [];
  const hasName = Boolean(attribute(element.openTag, 'aria-label')
    || attribute(element.openTag, 'aria-labelledby')
    || attribute(element.openTag, 'title')
    || innerText(html, element));
  if (hasName) return [];
  return [finding({
    ruleId: 'button-name',
    impact: 'critical',
    standard: 'WCAG 2.2 A · 4.1.2 Name, Role, Value',
    selector: '.promo-dismiss',
    measured: 'no accessible name',
    required: 'discernible text or aria-label',
    detail: 'screen readers announce the dismiss control as an unlabelled element',
  })];
}

function checkInteractiveSemantics(html) {
  const findings = [];
  const element = elementByClass(html, 'promo-cta');
  if (element && element.tag !== 'button' && element.tag !== 'a') {
    const keyboard = /\bon(keydown|keypress|keyup)=/.test(element.openTag);
    if (!keyboard) {
      findings.push(finding({
        ruleId: 'keyboard-operable',
        impact: 'serious',
        standard: 'WCAG 2.2 A · 2.1.1 Keyboard',
        selector: '.promo-cta',
        measured: `<${element.tag} role="${attribute(element.openTag, 'role') || 'none'}"> with no key handler`,
        required: 'a native <button>',
        detail: 'the offer-details control cannot be activated with Enter or Space',
      }));
    }
  }
  const dismiss = elementByClass(html, 'promo-dismiss');
  if (dismiss && dismiss.tag !== 'button') {
    findings.push(finding({
      ruleId: 'interactive-role',
      impact: 'moderate',
      standard: 'WCAG 2.2 A · 4.1.2 Name, Role, Value',
      selector: '.promo-dismiss',
      measured: `<${dismiss.tag}>`,
      required: '<button>',
      detail: 'the dismiss control is not exposed as a button to assistive technology',
    }));
  }
  return findings;
}

function checkLayoutStability(html) {
  const element = elementByClass(html, 'promo-art');
  if (!element) return [];
  const findings = [];
  if (!attribute(element.openTag, 'width') || !attribute(element.openTag, 'height')) {
    findings.push(finding({
      ruleId: 'image-size-attributes',
      impact: 'serious',
      standard: 'Core Web Vitals · Cumulative Layout Shift',
      selector: '.promo-art',
      measured: 'no intrinsic width/height',
      required: 'width and height attributes',
      detail: 'the banner image reserves no space and pushes the plan grid down as it loads',
    }));
  }
  if (attribute(element.openTag, 'loading') === 'lazy') {
    findings.push(finding({
      ruleId: 'lcp-lazy-loaded',
      impact: 'serious',
      standard: 'Core Web Vitals · Largest Contentful Paint',
      selector: '.promo-art',
      measured: 'loading="lazy" above the fold',
      required: 'loading="eager" with fetchpriority="high"',
      detail: 'the largest above-the-fold image is deferred, delaying LCP',
    }));
  }
  return findings;
}

/**
 * Audit the plan page markup for the accessibility and Core Web Vitals defects
 * the promo banner shipped with. Returns one finding per violated rule.
 */
function auditPlanPage(html) {
  const source = typeof html === 'string' ? html : fs.readFileSync(PAGE_FILE, 'utf8');
  const css = readStyleSheet(source);
  return [
    ...checkContrast(css),
    ...checkAccessibleName(source),
    ...checkInteractiveSemantics(source),
    ...checkTargetSize(css),
    ...checkLayoutStability(source),
  ];
}

function formatFindings(findings) {
  return findings
    .map((item) => `${item.ruleId} (${item.impact}) ${item.selector}: ${item.measured} — needs ${item.required}`)
    .join('\n');
}

/**
 * Raise the audit result as a production-shaped event: Datadog metric, Sentry
 * issue and a Slack alert that opens a Devin session with the remediation
 * directive. Called by the nightly audit and by POST /api/a75ccde9/quality-audit.
 */
function reportQualityFindings(findings, options = {}) {
  const reference = uuidv4();
  const worst = findings.some((item) => item.impact === 'critical') ? 'critical' : 'serious';
  const rules = [...new Set(findings.map((item) => item.ruleId))];
  const errorMessage = `${findings.length} accessibility and Core Web Vitals violations on ${PAGE_URL}`;
  const errorType = 'FrontendQualityRegression';
  const tags = {
    route: PAGE_URL,
    service: AUDIT_SERVICE,
    customer: CUSTOMER,
    platform: 'web',
    screen: 'plan_change',
    scenario: SCENARIO,
    worst_impact: worst,
  };

  incrementMetric('web_quality.violations', {
    route: PAGE_URL,
    errorClass: errorType,
    platform: 'web',
  });

  logger.error('Frontend quality audit found violations', {
    reference,
    service: AUDIT_SERVICE,
    violations: findings.length,
    rules,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  error.stack = `${errorType}: ${errorMessage}\n${formatFindings(findings)}`;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`AUDIT ${PAGE_URL}`);
    Sentry.captureException(error, {
      tags: { ...tags, alert_path: 'audit' },
      extra: { reference, findings },
    });
  });

  const sessionPromise = createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${AUDIT_PROJECT}&query=is%3Aunresolved`,
    culprit: 'app/public/verticals/a75ccde9.html — promo banner',
    errorType,
    errorValue: errorMessage,
    devinUserId: options.devinUserId,
    devinEmail: options.devinEmail || OWNER.email,
    devinOrgId: options.devinOrgId,
    slackMemberId: OWNER.slackMemberId,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: AUDIT_SERVICE,
    verticalLabel: 'FOX One',
    promptAppendix: AUDIT_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: { reference, findings },
    level: 'error',
    platform: 'web',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: String(findings.length),
    shortId: '',
    project: AUDIT_PROJECT,
    release: AUDIT_RELEASE,
    environment: options.environment || process.env.DD_ENV || 'prod',
    triggeredRule: 'Nightly frontend quality audit',
  }).catch((error) => {
    logger.error('Failed to create Devin session for frontend quality audit', {
      error: error.message,
      reference,
    });
  });

  return { reference, sessionPromise };
}

module.exports = {
  AUDIT_PROJECT,
  AUDIT_RELEASE,
  AUDIT_REMEDIATION_DIRECTIVE,
  AUDIT_SERVICE,
  MIN_CONTRAST,
  MIN_TARGET_PX,
  PAGE_FILE,
  PAGE_URL,
  SCENARIO,
  auditPlanPage,
  contrastRatio,
  formatFindings,
  reportQualityFindings,
};
