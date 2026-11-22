import { Hono } from "hono";
import { getOrderHandler, getUserHandler } from "./handlers";

const users = new Hono();
users.get("/users", (c) => c.json([]));
users.get("/users/:id", getUserHandler);
users.post("/users", (c) => c.json({}));

const orders = new Hono();
orders.get("/orders/:id", getOrderHandler);

export const app = new Hono();
app.get("/health", (c) => c.text("ok"));
app.route("/api", users);
app.route("/api", orders);
