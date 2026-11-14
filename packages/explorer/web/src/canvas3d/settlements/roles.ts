// What a file is for, read from its path: it picks the building's shape (a test file is a lab, a config file a water
// tower, a component a shop, a route a station hall). Pure string rules, no file contents.

export const ROLES = ["code", "component", "route", "config", "test", "entry"] as const;
export type Role = (typeof ROLES)[number];

const TEST_RE = /(^|\/)(__tests__|__mocks__|tests?|e2e|spec)\/|\.(test|spec|e2e|stories)\.[cm]?[jt]sx?$/i;
const CONFIG_RE =
  /(^|\/)(config|configs|settings)\/|(\.|^|\/)(config|conf|rc)\.[cm]?[jt]s$|\.config\.[cm]?[jt]sx?$|(^|\/)\.[a-z]+rc(\.[a-z]+)?$|\.(json|ya?ml|toml)$/i;
const ROUTE_RE =
  /(^|\/)(routes?|pages|app|api|handlers?|controllers?|endpoints?|commands?|graphql|resolvers?)\/|(route|handler|controller|resolver|endpoint|command)s?\.[cm]?[jt]sx?$/i;
const COMPONENT_RE = /(^|\/)(components?|ui|views?|widgets?|screens?)\/|\.[jt]sx$/i;
const ENTRY_RE = /(^|\/)(index|main|mod)\.[cm]?[jt]sx?$/i;

/** The role of a file by its repo-relative path. The first matching rule wins, in the order of `ROLES` reversed. */
export function roleOf(path: string): Role {
  if (TEST_RE.test(path)) return "test";
  if (CONFIG_RE.test(path)) return "config";
  if (ENTRY_RE.test(path)) return "entry";
  if (ROUTE_RE.test(path)) return "route";
  if (COMPONENT_RE.test(path)) return "component";
  return "code";
}

export const ROLE_LABEL: Record<Role, string> = {
  code: "source file",
  component: "component (.tsx, components/)",
  route: "route, page, handler or command",
  config: "config file",
  test: "test file",
  entry: "entry point (index, main)",
};
