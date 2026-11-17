// Hand labels: every request call site, by file and call line, with the endpoint it should link to (null: none).
// `pattern` names the construct; see the report's pattern table.
export interface Label {
  file: string;
  line: number;
  expect: string | null;
  pattern: string;
  note?: string;
}

const U = "@fx/users-api";
const B = "@fx/billing";
const W = "apps/web/src/features/users.ts";

export const FIXTURE_LABELS: Label[] = [
  { file: W, line: 5, expect: `GET /api/users/:id @${U}`, pattern: "env-template (process.env)" },
  {
    file: W,
    line: 9,
    expect: `POST /api/users @${U}`,
    pattern: "env-template (import.meta.env) + init.method",
  },
  { file: W, line: 13, expect: `GET /api/users/:id @${U}`, pattern: "string concatenation with base const" },
  { file: W, line: 17, expect: `GET /api/users/:id @${U}`, pattern: "axios instance, baseURL from env" },
  { file: W, line: 18, expect: `DELETE /api/users/:id @${U}`, pattern: "axios instance, baseURL from env" },
  { file: W, line: 19, expect: `PUT /api/users/:id @${U}`, pattern: "axios instance, baseURL from env" },
  { file: W, line: 23, expect: `GET /api/users/:id @${U}`, pattern: "ky.create prefixUrl" },
  { file: W, line: 27, expect: `GET /api/users/:id @${U}`, pattern: "wrapper apiFetch(path)" },
  { file: W, line: 28, expect: `POST /api/users @${U}`, pattern: "wrapper apiFetch(path, init)" },
  { file: W, line: 32, expect: `PUT /api/users/:id @${U}`, pattern: "wrapper request(method, path)" },
  { file: W, line: 37, expect: `GET /api/orders/:id @${U}`, pattern: "URL built in a const" },
  {
    file: W,
    line: 42,
    expect: null,
    pattern: "new URL(absPath, base)",
    note: "absolute path drops the base's /api, so it requests /orders/:id, which no backend serves",
  },
  { file: W, line: 46, expect: `GET /api/users @${U}`, pattern: "enum member path" },
  {
    file: W,
    line: 50,
    expect: `GET /api/users/me @${U}`,
    pattern: "as-const object path (literal beats :id)",
  },
  { file: W, line: 54, expect: `GET /health @${B}`, pattern: "second backend by env var" },
  { file: W, line: 55, expect: `GET /invoices/:id @${B}`, pattern: "second backend axios instance" },
  {
    file: W,
    line: 59,
    expect: null,
    pattern: "same path on two backends",
    note: "base carries /api, so this is /api/health, which does not exist",
  },
  { file: W, line: 63, expect: `GET /api/users @${U}`, pattern: "relative path through a dev proxy" },
  {
    file: W,
    line: 67,
    expect: `GET /api/posts/:postId/comments @${U}`,
    pattern: "nested params + query string",
  },
  { file: W, line: 71, expect: null, pattern: "fully dynamic path segments" },
  { file: W, line: 75, expect: null, pattern: "URL from a parameter (not a wrapper call site)" },
  { file: W, line: 79, expect: null, pattern: "external absolute URL" },
  { file: W, line: 83, expect: `DELETE /api/users/:id @${U}`, pattern: "axios config object on instance" },
  { file: "apps/web/src/lib/http.ts", line: 10, expect: null, pattern: "wrapper body" },
  { file: "apps/web/src/lib/http.ts", line: 15, expect: null, pattern: "wrapper body" },
];

const S = "sosrs-api";
const svc = (p: string) => `apps/web/src/service/${p}`;
const hook = (p: string) => `apps/web/src/hooks/${p}`;
export const SOSRS_LABELS: Label[] = [
  {
    file: svc("donationOrder/donationOrder.service.ts"),
    line: 13,
    expect: `POST /donation/order @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("donationOrder/donationOrder.service.ts"),
    line: 20,
    expect: `GET /donation/order @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("donationOrder/donationOrder.service.ts"),
    line: 28,
    expect: `GET /donation/order/:id @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("donationOrder/donationOrder.service.ts"),
    line: 34,
    expect: `PUT /donation/order/:orderId @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("shelterSupply/shelter-supply.service.ts"),
    line: 15,
    expect: `PUT /shelter/supplies/:shelterId/:supplyId @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("shelterSupply/shelter-supply.service.ts"),
    line: 22,
    expect: `POST /shelter/supplies @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("shelterSupply/shelter-supply.service.ts"),
    line: 28,
    expect: `GET /shelter/supplies/:shelterId @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("supply/supply.service.ts"),
    line: 7,
    expect: `POST /supplies @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("sessions/session.service.ts"),
    line: 7,
    expect: `POST /sessions @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("sessions/session.service.ts"),
    line: 14,
    expect: `GET /sessions @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("sessions/session.service.ts"),
    line: 18,
    expect: `DELETE /sessions @${S}`,
    pattern: "axios instance",
  },
  { file: svc("users/user.service.ts"), line: 8, expect: `POST /users @${S}`, pattern: "axios instance" },
  { file: svc("users/user.service.ts"), line: 15, expect: `PUT /users/:id @${S}`, pattern: "axios instance" },
  {
    file: svc("users/user.service.ts"),
    line: 25,
    expect: `GET /users/find/:field/:value @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("shelter/shelter.service.ts"),
    line: 8,
    expect: `POST /shelters @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("shelter/shelter.service.ts"),
    line: 12,
    expect: `GET /shelters @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("shelter/shelter.service.ts"),
    line: 16,
    expect: `GET /shelters/:id @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("shelter/shelter.service.ts"),
    line: 25,
    expect: `PUT /shelters/:id @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("shelter/shelter.service.ts"),
    line: 32,
    expect: `PUT /shelters/:id/admin @${S}`,
    pattern: "axios instance",
  },
  {
    file: svc("petsRsShelter/petsRsShelter.service.ts"),
    line: 7,
    expect: null,
    pattern: "external absolute URL",
  },
  {
    file: hook("useShelters/useShelters.tsx"),
    line: 27,
    expect: `GET /shelters @${S}`,
    pattern: "axios instance, enum path",
  },
  {
    file: hook("useDashboard/useDashboard.tsx"),
    line: 26,
    expect: `GET /dashboard @${S}`,
    pattern: "axios instance, enum path",
  },
  { file: hook("useFetch/useFetch.tsx"), line: 21, expect: null, pattern: "wrapper body" },
  { file: hook("usePaginatedQuery/usePaginatedQuery.tsx"), line: 24, expect: null, pattern: "wrapper body" },
  {
    file: hook("useGithubContributors/useGithubContributors.tsx"),
    line: 13,
    expect: null,
    pattern: "external absolute URL",
  },
  {
    file: hook("useSupporters/useSupporters.tsx"),
    line: 5,
    expect: `GET /supporters @${S}`,
    pattern: "wrapper useFetch(path)",
  },
  {
    file: hook("useSupplyCategories/useSupplyCategories.tsx"),
    line: 6,
    expect: `GET /supply-categories @${S}`,
    pattern: "wrapper useFetch(enum)",
  },
  {
    file: hook("useViaCep/useViaCep.ts"),
    line: 9,
    expect: null,
    pattern: "wrapper, conditional external URL",
  },
  {
    file: hook("useShelter/useShelter.tsx"),
    line: 6,
    expect: `GET /shelters/:id @${S}`,
    pattern: "wrapper useFetch(enum + param)",
  },
  {
    file: hook("useDonationOrder/useDonationOrder.tsx"),
    line: 5,
    expect: `GET /donation/order/:id @${S}`,
    pattern: "wrapper useFetch(template)",
  },
  {
    file: hook("useShelterCities/useShelterCities.ts"),
    line: 6,
    expect: `GET /shelters/cities @${S}`,
    pattern: "wrapper useFetch(enum), literal beats :id",
  },
  {
    file: hook("useDonations/useDonations.tsx"),
    line: 6,
    expect: `GET /donation/order @${S}`,
    pattern: "wrapper useFetch(enum in template)",
  },
  {
    file: hook("useSupplies/useSupplies.tsx"),
    line: 6,
    expect: `GET /supplies @${S}`,
    pattern: "wrapper useFetch(enum)",
  },
  {
    file: hook("usePartners/usePartners.tsx"),
    line: 5,
    expect: `GET /partners @${S}`,
    pattern: "wrapper useFetch(path)",
  },
];

const J = "juga-api";
const js = (p: string) => `apps/web/src/service/${p}`;
export const JUGA_LABELS: Label[] = [
  {
    file: js("assets.ts"),
    line: 8,
    expect: `GET /api/assets @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("assets.ts"),
    line: 21,
    expect: `GET /api/assets/cash @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("assets.ts"),
    line: 39,
    expect: `GET /api/assets/stocks/:stockCode @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("auth.ts"),
    line: 7,
    expect: `POST /api/auth/login @${J}`,
    pattern: "env-template + init.method",
  },
  {
    file: js("auth.ts"),
    line: 22,
    expect: `GET /api/auth/check @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("auth.ts"),
    line: 33,
    expect: `GET /api/auth/logout @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("bookmark.ts"),
    line: 8,
    expect: `POST /api/stocks/bookmark/:stockCode @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("bookmark.ts"),
    line: 22,
    expect: `DELETE /api/stocks/bookmark/:stockCode @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("bookmark.ts"),
    line: 36,
    expect: `GET /api/stocks/bookmark @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  { file: js("news.ts"), line: 2, expect: `GET /api/news @${J}`, pattern: "env-template" },
  {
    file: js("orders.ts"),
    line: 12,
    expect: `POST /api/stocks/order/buy @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("orders.ts"),
    line: 35,
    expect: `POST /api/stocks/order/sell @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("orders.ts"),
    line: 54,
    expect: `GET /api/stocks/order/list @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("orders.ts"),
    line: 67,
    expect: `DELETE /api/stocks/order/:orderId @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  { file: js("ranking.ts"), line: 2, expect: `GET /api/ranking @${J}`, pattern: "env-template" },
  {
    file: js("search.ts"),
    line: 4,
    expect: `GET /api/stocks/list/search @${J}`,
    pattern: "env-template + query, literal beats :code",
  },
  {
    file: js("stocks.ts"),
    line: 8,
    expect: `GET /api/stocks/detail/:stockCode @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("stocks.ts"),
    line: 21,
    expect: `POST /api/stocks/detail/:stockCode @${J}`,
    pattern: "env-template + init.method",
  },
  {
    file: js("stocks.ts"),
    line: 32,
    expect: `GET /api/stocks/trade-history/unsubscribe @${J}`,
    pattern: "env-template + query",
  },
  {
    file: js("stocks.ts"),
    line: 41,
    expect: `GET /api/stocks/topfive @${J}`,
    pattern: "env-template + query",
  },
  { file: js("stocks.ts"), line: 51, expect: `GET /api/stocks/index @${J}`, pattern: "env-template" },
  {
    file: js("tradeHistory.ts"),
    line: 7,
    expect: null,
    pattern: "last segment from a union-typed parameter",
    note: "`today` or `daily`: two candidates; only types narrow it",
  },
  {
    file: js("user.ts"),
    line: 8,
    expect: `GET /api/user/profile @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
  {
    file: js("user.ts"),
    line: 19,
    expect: `PATCH /api/user/rename @${J}`,
    pattern: "PROD ? env-template : proxy path, in a const",
  },
];
