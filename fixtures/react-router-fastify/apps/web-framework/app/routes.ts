import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

export default [
  route("contact", "./contact.tsx"),
  layout("./layouts/dashboard.tsx", [
    route("dashboard", "./dashboard/index.tsx"),
    route("dashboard/settings", "./dashboard/settings.tsx"),
  ]),
  ...prefix("admin", [
    index("./admin/index.tsx"),
    route("users", "./admin/users.tsx"),
    route("users/:userId", "./admin/user.tsx"),
  ]),
  ...(await flatRoutes({ rootDirectory: "routes/flat" })),
] satisfies RouteConfig;
