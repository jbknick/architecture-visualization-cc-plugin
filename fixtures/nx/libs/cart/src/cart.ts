export interface CartItem { sku: string; price: number }

export function addItem(cart: CartItem[], item: CartItem): CartItem[] {
  return [...cart, item];
}

export function totalPrice(cart: CartItem[]): number {
  return cart.reduce((sum, i) => sum + i.price, 0);
}
