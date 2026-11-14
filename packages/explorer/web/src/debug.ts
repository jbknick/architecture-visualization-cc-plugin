/** Debug UI (layout strategy, timing, zoom level, the "Debug: workspaces" tab) is shown only with `?debug=1` or the `gantry.debug` flag. */
export function debugEnabled(): boolean {
  try {
    if (/[?&]debug=1(&|$)/.test(`${window.location.search}&${window.location.hash.split("?")[1] ?? ""}`))
      return true;
    return window.localStorage.getItem("gantry.debug") === "1";
  } catch {
    return false;
  }
}
