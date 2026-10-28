/**
 * Minimal fixed-point decimal helpers (BigInt units + scale) so COBOL packed
 * decimal and Java BigDecimal arithmetic can be reproduced exactly.
 */

function parse(value) {
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace(/^[-+]/, '').split('.');
  const units = BigInt(`${whole || '0'}${frac}`);
  return { units: negative ? -units : units, scale: frac.length };
}

function pow10(n) {
  return 10n ** BigInt(n);
}

function align(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

function add(a, b) {
  const [x, y, scale] = align(a, b);
  return { units: x + y, scale };
}

function subtract(a, b) {
  const [x, y, scale] = align(a, b);
  return { units: x - y, scale };
}

function multiply(a, b) {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/**
 * Rescale to `scale` digits using a java.math.RoundingMode name.
 */
function setScale(value, scale, mode) {
  if (scale >= value.scale) {
    return { units: value.units * pow10(scale - value.scale), scale };
  }
  const divisor = pow10(value.scale - scale);
  const sign = value.units < 0n ? -1n : 1n;
  const abs = value.units * sign;
  let quotient = abs / divisor;
  const twiceRemainder = (abs % divisor) * 2n;
  if (mode === 'HALF_UP') {
    if (twiceRemainder >= divisor) quotient += 1n;
  } else if (mode === 'HALF_EVEN') {
    if (twiceRemainder > divisor || (twiceRemainder === divisor && quotient % 2n === 1n)) quotient += 1n;
  } else if (mode === 'UP') {
    if (twiceRemainder > 0n) quotient += 1n;
  } else if (mode !== 'DOWN') {
    throw new Error(`Unsupported rounding mode ${mode}`);
  }
  return { units: quotient * sign, scale };
}

function format(value) {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const whole = value.scale ? digits.slice(0, -value.scale) : digits;
  const frac = value.scale ? `.${digits.slice(-value.scale)}` : '';
  return `${negative ? '-' : ''}${whole}${frac}`;
}

function equals(a, b) {
  const [x, y] = align(a, b);
  return x === y;
}

module.exports = {
  parse, add, subtract, multiply, setScale, format, equals,
};
