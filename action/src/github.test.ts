import { afterEach, describe, expect, it } from "vitest";
import { MARKER } from "./comment.js";
import { GithubComments } from "./github.js";
import { type FakeGithub, startFakeGithub } from "./testkit.js";

let fake: FakeGithub | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const client = (api: FakeGithub, over: { token?: string } = {}): GithubComments =>
  new GithubComments(
    { apiUrl: api.url, token: over.token ?? "test-token", repo: "octo/repo", pr: 7 },
    { sleep: async () => undefined },
  );

describe("pull request comment upsert (fake GitHub API)", () => {
  it("creates one comment, then updates that comment in place", async () => {
    fake = await startFakeGithub();
    const first = await client(fake).upsert(`${MARKER}\nfirst`);
    expect(first.action).toBe("created");
    expect(fake.comments).toHaveLength(1);
    const id = fake.comments[0]?.id;

    const second = await client(fake).upsert(`${MARKER}\nsecond`);
    expect(second.action).toBe("updated");
    expect(second).toMatchObject({ id });
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.body).toBe(`${MARKER}\nsecond`);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("finds its comment on a later page of the list", async () => {
    fake = await startFakeGithub({
      pageSize: 2,
      comments: [
        { body: "one", login: "a" },
        { body: "two", login: "b" },
        { body: "three", login: "c" },
        { body: "four", login: "d" },
        { body: `${MARKER}\nold`, login: "github-actions[bot]" },
        { body: "six", login: "e" },
      ],
    });
    const r = await client(fake).upsert(`${MARKER}\nnew`);
    expect(r.action).toBe("updated");
    expect(fake.comments).toHaveLength(6);
    expect(fake.comments[4]?.body).toBe(`${MARKER}\nnew`);
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(3); // pages 1, 2 and 3
  });

  it("ignores comments that only mention the marker", async () => {
    fake = await startFakeGithub({
      comments: [{ body: `quoting ${MARKER} in a reply`, login: "someone" }],
    });
    const r = await client(fake).upsert(`${MARKER}\nbody`);
    expect(r.action).toBe("created");
    expect(fake.comments).toHaveLength(2);
  });

  it("skips, without throwing, when the token cannot comment (403)", async () => {
    fake = await startFakeGithub({ refuseWrites: 403 });
    const r = await client(fake).upsert(`${MARKER}\nbody`);
    expect(r).toMatchObject({ action: "skipped" });
    expect(r.action === "skipped" && r.reason).toContain("HTTP 403");
    expect(fake.comments).toHaveLength(0);
  });

  it("skips when the token cannot even read the comments", async () => {
    fake = await startFakeGithub({ refuseReads: 403 });
    const r = await client(fake).upsert(`${MARKER}\nbody`);
    expect(r.action).toBe("skipped");
  });

  it("skips on a bad token (401)", async () => {
    fake = await startFakeGithub();
    const r = await client(fake, { token: "wrong" }).upsert(`${MARKER}\nbody`);
    expect(r.action === "skipped" && r.reason).toContain("HTTP 401");
  });

  it("creates its own comment when the earlier one cannot be edited", async () => {
    fake = await startFakeGithub({
      comments: [{ body: `${MARKER}\nsomeone else's look-alike`, login: "someone" }],
    });
    const server = fake;
    // the look-alike belongs to someone else: updating it is refused, so a new comment is made
    const realFetch = globalThis.fetch;
    const patched: typeof fetch = async (url, init) =>
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 })
        : realFetch(url, init);
    const r = await new GithubComments(
      { apiUrl: server.url, token: "test-token", repo: "octo/repo", pr: 7 },
      { fetch: patched, sleep: async () => undefined },
    ).upsert(`${MARKER}\nmine`);
    expect(r.action).toBe("created");
    expect(server.comments).toHaveLength(2);
  });

  it("retries a server error and then succeeds", async () => {
    fake = await startFakeGithub({ failWrites: 2 });
    const r = await client(fake).upsert(`${MARKER}\nbody`);
    expect(r.action).toBe("created");
    expect(fake.calls.filter((c) => c.status === 502)).toHaveLength(2);
  });

  it("skips when the API keeps failing", async () => {
    fake = await startFakeGithub({ failWrites: 10 });
    const r = await client(fake).upsert(`${MARKER}\nbody`);
    expect(r.action === "skipped" && r.reason).toContain("HTTP 502");
  });
});
