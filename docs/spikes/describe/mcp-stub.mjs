// Temporary stdio MCP stub for the issue #6 Path B spike. Not product code: it stands in for the Gantry MCP server
// so a describer-style subagent can claim fact sheets from the labelled JSONL and submit descriptions.
// Env: STUB_DATA (labelled jsonl, required), STUB_OUT (output dir, required), STUB_BATCH (default 40).
// Tools: claim_batch {} -> up to STUB_BATCH fact sheets; submit { results: [{ content_key, description }] }.
// Every claim and accepted submission is appended with a timestamp to STUB_OUT/events.jsonl (private data).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const rows = readFileSync(process.env.STUB_DATA, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const batchSize = Number(process.env.STUB_BATCH ?? 40);
mkdirSync(process.env.STUB_OUT, { recursive: true });
const events = join(process.env.STUB_OUT, "events.jsonl");
const log = (e) => appendFileSync(events, `${JSON.stringify({ t: new Date().toISOString(), ...e })}\n`);
const todo = rows.map((r) => r.factSheet.contentKey);
const claimed = new Set();
const done = new Set();
const IDENT = /^[A-Za-z_$][\w$]*$/;

const render = (f) =>
  [
    `=== FACT SHEET ${f.contentKey} ===`,
    `kind: ${f.kind}`,
    `name: ${f.id.slice(f.id.lastIndexOf("#") + 1)}`,
    `path: ${f.path}`,
    `signature: ${f.signature}`,
    `doc: ${f.doc ?? "none"}`,
    `callees: ${f.callees.join(", ") || "none"}`,
    `returnType: ${f.returnType ?? "none"}`,
    "body:",
    f.body,
  ].join("\n");

function problems(d) {
  const p = [];
  if (!d || typeof d.behavior !== "string" || !d.behavior) p.push("behavior missing");
  else if (d.behavior.length > 200 || d.behavior.split(/\s+/).length > 25)
    p.push("behavior over 25 words or 200 chars");
  if (
    !Array.isArray(d?.searchTerms) ||
    d.searchTerms.length < 1 ||
    d.searchTerms.length > 6 ||
    d.searchTerms.some((s) => typeof s !== "string" || s.length > 30)
  )
    p.push("searchTerms 1-6 strings of at most 30 chars");
  if (typeof d?.nameFits !== "boolean") p.push("nameFits must be boolean");
  else if (!d.nameFits && !IDENT.test(d.suggestedName ?? ""))
    p.push("suggestedName required when nameFits is false");
  return p;
}

const tools = [
  {
    name: "claim_batch",
    description: "Claim the next batch of fact sheets to describe. Returns text, or 'QUEUE EMPTY'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "submit",
    description:
      "Submit descriptions for claimed fact sheets. Returns accepted keys and per-key problems to fix and resubmit.",
    inputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: { content_key: { type: "string" }, description: { type: "object" } },
            required: ["content_key", "description"],
          },
        },
      },
      required: ["results"],
    },
  },
];

function callTool(name, args) {
  if (name === "claim_batch") {
    // Claimed-but-unsubmitted sheets are handed out again first, so a confused caller never loses a batch.
    const pending = todo.filter((k) => claimed.has(k) && !done.has(k)).slice(0, batchSize);
    const keys = pending.length > 0 ? pending : todo.filter((k) => !done.has(k)).slice(0, batchSize);
    if (keys.length === 0) return "QUEUE EMPTY";
    for (const k of keys) claimed.add(k);
    log({ ev: "claim", n: keys.length, reissued: pending.length > 0 });
    return keys.map((k) => render(rows[todo.indexOf(k)].factSheet)).join("\n\n");
  }
  const rejected = [];
  const accepted = [];
  for (const r of args?.results ?? []) {
    const p =
      claimed.has(r.content_key) && !done.has(r.content_key)
        ? problems(r.description)
        : ["unknown or already submitted content_key"];
    if (p.length) rejected.push({ content_key: r.content_key, problems: p });
    else {
      done.add(r.content_key);
      accepted.push(r.content_key);
      log({ ev: "accept", key: r.content_key, description: r.description });
    }
  }
  log({ ev: "submit", accepted: accepted.length, rejected: rejected.length });
  return JSON.stringify({ accepted: accepted.length, rejected, remaining: todo.length - done.size });
}

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  let m;
  try {
    m = JSON.parse(l);
  } catch {
    return;
  }
  if (m.method === "initialize")
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "gantrystub", version: "0.0.1" },
      },
    });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  else if (m.method === "tools/call")
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: { content: [{ type: "text", text: callTool(m.params.name, m.params.arguments) }] },
    });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
