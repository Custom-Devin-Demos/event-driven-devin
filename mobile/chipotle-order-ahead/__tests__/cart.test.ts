import {
  addToCart,
  removeFromCart,
  cartQuantity,
  cartSubtotal,
  CartLine,
} from '../src/lib/cart';

describe('cart', () => {
  it('adds a new item to an empty cart', () => {
    const cart = addToCart([], 'ENT-BOWL');
    expect(cart).toHaveLength(1);
    expect(cart[0].item.id).toBe('ENT-BOWL');
    expect(cart[0].qty).toBe(1);
  });

  it('increments quantity when the same item is added again', () => {
    let cart: CartLine[] = addToCart([], 'ENT-BOWL');
    cart = addToCart(cart, 'ENT-BOWL', 2);
    expect(cart).toHaveLength(1);
    expect(cart[0].qty).toBe(3);
  });

  it('throws on an unknown menu item', () => {
    expect(() => addToCart([], 'NOPE-000')).toThrow('Unknown menu item');
  });

  it('removes an item from the cart', () => {
    let cart = addToCart([], 'ENT-BOWL');
    cart = addToCart(cart, 'DRK-FTN');
    cart = removeFromCart(cart, 'ENT-BOWL');
    expect(cart).toHaveLength(1);
    expect(cart[0].item.id).toBe('DRK-FTN');
  });

  it('counts total units across lines', () => {
    let cart = addToCart([], 'ENT-BOWL', 2);
    cart = addToCart(cart, 'DRK-FTN', 3);
    expect(cartQuantity(cart)).toBe(5);
  });

  it('computes the subtotal', () => {
    let cart = addToCart([], 'ENT-BOWL'); // 9.65
    cart = addToCart(cart, 'DRK-FTN'); // 2.95
    expect(cartSubtotal(cart)).toBeCloseTo(12.6, 2);
  });
});
