const ORDERS = "/api/orders";

export const loadOrder = (id: string) => fetch(`${ORDERS}/${id}`);
