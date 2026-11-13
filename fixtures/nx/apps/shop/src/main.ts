import { addItem, totalPrice } from "@shop/cart";

const cart = addItem([], { sku: "A1", price: 5 });
console.log(totalPrice(cart));
