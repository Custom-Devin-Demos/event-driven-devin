export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: number;
}

/**
 * Chipotle "Order Ahead" digital menu (approximate in-app pricing).
 */
export const MENU: MenuItem[] = [
  { id: 'ENT-BOWL', name: 'Burrito Bowl', category: 'Entrees', price: 9.65 },
  { id: 'ENT-BURR', name: 'Burrito', category: 'Entrees', price: 9.65 },
  { id: 'ENT-TACO', name: 'Tacos (3)', category: 'Entrees', price: 9.65 },
  { id: 'ENT-QUES', name: 'Quesadilla', category: 'Entrees', price: 11.2 },
  { id: 'ADD-GUAC', name: 'Add Guacamole', category: 'Add-Ons', price: 2.75 },
  { id: 'ADD-QUESO', name: 'Add Queso Blanco', category: 'Add-Ons', price: 2.55 },
  { id: 'SIDE-CHIPS', name: 'Chips & Guacamole', category: 'Sides', price: 4.6 },
  { id: 'DRK-FTN', name: 'Fountain Drink', category: 'Drinks', price: 2.95 },
  { id: 'DRK-MEXCOKE', name: 'Mexican Coca-Cola', category: 'Drinks', price: 3.35 },
];

export function findItem(id: string): MenuItem | undefined {
  return MENU.find((m) => m.id === id);
}

export function itemsByCategory(category: string): MenuItem[] {
  return MENU.filter((m) => m.category === category);
}

export const CATEGORIES: string[] = ['Entrees', 'Add-Ons', 'Sides', 'Drinks'];
