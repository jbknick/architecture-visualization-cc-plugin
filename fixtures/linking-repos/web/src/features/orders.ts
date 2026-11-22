const ORDERS = "/api/orders";

export const loadCurrentOrder = () => fetch(`${ORDERS}/current`);
