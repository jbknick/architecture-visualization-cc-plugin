export interface ExplorerUrlOptions {
  port: number;
  token: string;
  view?: string;
  focus?: string;
  filters?: Record<string, string> | string;
}

/** `http://127.0.0.1:<port>/?t=<token>#/<view>?focus=<id>&<filters>` */
export function buildExplorerUrl(o: ExplorerUrlOptions): string {
  let url = `http://127.0.0.1:${o.port}/?t=${encodeURIComponent(o.token)}`;
  if (o.view) {
    const q: string[] = [];
    if (o.focus) q.push(`focus=${encodeURIComponent(o.focus)}`);
    if (typeof o.filters === "string") {
      if (o.filters) q.push(o.filters);
    } else if (o.filters) {
      for (const [k, v] of Object.entries(o.filters)) {
        q.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
    }
    url += `#/${encodeURIComponent(o.view)}${q.length ? `?${q.join("&")}` : ""}`;
  }
  return url;
}
