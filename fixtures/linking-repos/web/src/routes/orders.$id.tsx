import { createFileRoute } from "@tanstack/react-router";
import { loadOrder } from "../features/orders";

export const Route = createFileRoute("/orders/$id")({ component: OrderPage });

function OrderPage() {
  const { id } = Route.useParams();
  loadOrder(id);
  return <h1>Order {id}</h1>;
}
