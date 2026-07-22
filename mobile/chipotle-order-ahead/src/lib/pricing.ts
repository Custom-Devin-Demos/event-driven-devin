export type PromoType = 'percent' | 'fixed';

export interface Promo {
  code: string;
  type: PromoType;
  value: number;
}

/**
 * Promo codes available in the app.
 *   percent → fraction off the subtotal (0.2 = 20% off)
 *   fixed   → flat dollar amount off the subtotal
 */
export const PROMOS: Record<string, Promo> = {
  GUAC20: { code: 'GUAC20', type: 'percent', value: 0.2 },
  FREEGUAC: { code: 'FREEGUAC', type: 'fixed', value: 2.75 },
  WELCOME5: { code: 'WELCOME5', type: 'fixed', value: 5 },
};

/**
 * Sales-tax rate applied to the (post-discount) taxable amount, by state.
 */
export const STATE_TAX: Record<string, number> = {
  CA: 0.0725,
  CO: 0.029,
  IL: 0.1025,
  TX: 0.0825,
  NY: 0.08875,
};

const SERVICE_FEE_RATE = 0.05;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function lookupPromo(code: string): Promo | undefined {
  return PROMOS[code.trim().toUpperCase()];
}

/**
 * Apply a promo to a subtotal and return the discounted amount.
 */
export function applyPromo(subtotal: number, promo?: Promo): number {
  if (!promo) {
    return round(subtotal);
  }
  if (promo.type === 'percent') {
    return round(subtotal - subtotal * promo.value);
  }
  // fixed-dollar promo
  return round(subtotal - promo.value);
}

/**
 * Compute sales tax on the taxable amount for the given store state.
 */
export function calcTax(taxable: number, state: string): number {
  const rate = STATE_TAX[state] ?? 0;
  return round(taxable * rate);
}

/**
 * Digital-order service fee, charged on the discounted subtotal.
 */
export function calcServiceFee(discountedSubtotal: number): number {
  return round(discountedSubtotal * SERVICE_FEE_RATE);
}

export interface OrderTotals {
  subtotal: number;
  discount: number;
  tax: number;
  serviceFee: number;
  total: number;
}

/**
 * Compute the full order breakdown: subtotal, discount, tax, service fee, total.
 */
export function calcTotals(subtotal: number, state: string, promo?: Promo): OrderTotals {
  const discounted = applyPromo(subtotal, promo);
  const discount = round(subtotal - discounted);
  const tax = calcTax(discounted, state);
  const serviceFee = calcServiceFee(discounted);
  const total = round(discounted + tax + serviceFee);
  return { subtotal: round(subtotal), discount, tax, serviceFee, total };
}
