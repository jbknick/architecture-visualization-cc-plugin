import { createFileRoute } from "@tanstack/react-router";
import { loadInvoice } from "../features/invoices";

export const Route = createFileRoute("/invoices/$id")({ component: InvoicePage });

function InvoicePage() {
  const { id } = Route.useParams();
  loadInvoice(id);
  return <h1>Invoice {id}</h1>;
}
