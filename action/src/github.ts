// The GitHub REST calls of the Action (issue #282): find the earlier Gantry comment on a pull request by its hidden
// marker and update it, otherwise create one. Only `fetch`, no client library. A token that cannot comment (a pull
// request from a fork gets a read-only token) is a result, `skipped`, never a thrown error.
import { MARKER } from "./comment.js";

export interface GithubTarget {
  /** `GITHUB_API_URL`, for example `https://api.github.com`. */
  apiUrl: string;
  token: string;
  /** `owner/name`. */
  repo: string;
  /** The pull request number (its comments are issue comments). */
  pr: number;
}

export interface GithubClientOptions {
  fetch?: typeof fetch;
  /** Waits between retries of a server error; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export type CommentResult =
  | { action: "created" | "updated"; id: number; url: string }
  | { action: "skipped"; reason: string };

interface ApiComment {
  id: number;
  body?: string | null;
  html_url?: string;
}

/** A pull request has at most this many comment pages read (100 per page). */
const MAX_PAGES = 50;
const RETRIES = 2;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP statuses that mean "this token may not do that here": the comment goes to the job summary instead. */
const REFUSED = new Set([401, 403, 404]);

function describe(status: number, text: string): string {
  let msg = text.trim();
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") msg = parsed.message;
  } catch {
    // not JSON; keep the text
  }
  return `HTTP ${status}${msg ? ` ${msg.slice(0, 200)}` : ""}`;
}

export class GithubComments {
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly target: GithubTarget,
    opts: GithubClientOptions = {},
  ) {
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private url(path: string): string {
    return `${this.target.apiUrl.replace(/\/+$/, "")}/repos/${this.target.repo}${path}`;
  }

  private async request(method: string, url: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.target.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "gantry-action",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status >= 500 && attempt < RETRIES) {
        await res.arrayBuffer().catch(() => undefined);
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new ApiError(res.status, describe(res.status, await res.text().catch(() => "")));
      return res;
    }
  }

  /** The earliest comment of this pull request whose body starts with the marker, following `Link: rel="next"`. */
  async findExisting(): Promise<ApiComment | undefined> {
    let url: string | undefined = this.url(`/issues/${this.target.pr}/comments?per_page=100`);
    for (let page = 0; url !== undefined && page < MAX_PAGES; page++) {
      const res = await this.request("GET", url);
      const comments = (await res.json()) as ApiComment[];
      const hit = comments.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER));
      if (hit) return hit;
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    }
    return undefined;
  }

  /**
   * Updates the earlier Gantry comment in place, or creates the first one. Never throws for a refused token or a
   * failing API: it returns `skipped` with the reason, and the caller writes the body to the job summary.
   */
  async upsert(body: string): Promise<CommentResult> {
    try {
      const existing = await this.findExisting();
      if (existing) {
        try {
          const res = await this.request("PATCH", this.url(`/issues/comments/${existing.id}`), { body });
          const c = (await res.json()) as ApiComment;
          return { action: "updated", id: c.id, url: c.html_url ?? existing.html_url ?? "" };
        } catch (err) {
          // A comment that is gone, or that this token may not edit (a look-alike by someone else): make our own.
          if (!(err instanceof ApiError) || !REFUSED.has(err.status)) throw err;
        }
      }
      const res = await this.request("POST", this.url(`/issues/${this.target.pr}/comments`), { body });
      const c = (await res.json()) as ApiComment;
      return { action: "created", id: c.id, url: c.html_url ?? "" };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          action: "skipped",
          reason: REFUSED.has(err.status) ? `the token cannot comment (${err.message})` : err.message,
        };
      }
      return { action: "skipped", reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
