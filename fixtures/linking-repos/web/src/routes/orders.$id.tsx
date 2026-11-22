import { createFileRoute } from "@tanstack/react-router";
import { loadCurrentOrder } from "../features/orders";

export const Route = createFileRoute("/orders/$id")({ component: OrderPage });

function OrderPage() {
  const { id } = Route.useParams();
  loadCurrentOrder();
  return <h1>Order {id}</h1>;
}
