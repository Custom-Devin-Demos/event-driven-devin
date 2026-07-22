import { MenuItem, findItem } from './menu';

export interface CartLine {
  item: MenuItem;
  qty: number;
}

/**
 * Add an item to the cart. If the item is already present, increment its
 * quantity. Returns a new cart array (immutable update).
 */
export function addToCart(cart: CartLine[], itemId: string, qty = 1): CartLine[] {
  const item = findItem(itemId);
  if (!item) {
    throw new Error(`Unknown menu item: ${itemId}`);
  }
  const existing = cart.find((line) => line.item.id === itemId);
  if (existing) {
    return cart.map((line) =>
      line.item.id === itemId ? { ...line, qty: line.qty + qty } : line
    );
  }
  return [...cart, { item, qty }];
}

/**
 * Remove an item entirely from the cart.
 */
export function removeFromCart(cart: CartLine[], itemId: string): CartLine[] {
  return cart.filter((line) => line.item.id !== itemId);
}

/**
 * Total number of individual units in the cart.
 */
export function cartQuantity(cart: CartLine[]): number {
  return cart.reduce((sum, line) => sum + line.qty, 0);
}

/**
 * Subtotal (pre-tax, pre-discount) of the cart, rounded to cents.
 */
export function cartSubtotal(cart: CartLine[]): number {
  const raw = cart.reduce((sum, line) => sum + line.item.price * line.qty, 0);
  return Math.round(raw * 100) / 100;
}
