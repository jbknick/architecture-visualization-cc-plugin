import { useEffect, useState } from "react";
import type { GraphNode, NeighborRef, NodeDetail } from "../api.ts";
import { useNodeDetail } from "../hooks.ts";
import { useStore } from "../store.tsx";
import { isServerNode } from "../views/drill.ts";
import { KindBadge } from "./KindBadge.tsx";
import { SourcePreview } from "./SourcePreview.tsx";

const SOURCE_LINES = 40;

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** A readable name for an id nobody told us about, e.g. `sym:a/b.ts#Foo` becomes `Foo`. */
function shortLabel(id: string): string {
  const afterHash = id.split("#").pop() ?? id;
  return afterHash.split(/[:/]/).pop() || id;
}

/** Plain-words group titles for neighbors, by edge kind and direction. */
const GROUP_TITLES: Record<string, { out: string; in: string }> = {
  calls: { out: "Calls", in: "Called by" },
  renders: { out: "Renders", in: "Rendered by" },
  uses_hook: { out: "Uses hook", in: "Hook used by" },
  imports: { out: "Imports", in: "Imported by" },
  contains: { out: "Contains", in: "Part of" },
  depends_on: { out: "Depends on", in: "Needed by" },
  exports: { out: "Exports", in: "Exported from" },
  extends: { out: "Extends", in: "Extended by" },
  implements: { out: "Implements", in: "Implemented by" },
  references_type: { out: "Uses type", in: "Type used by" },
  serves: { out: "Serves", in: "Served by" },
  handles: { out: "Handles", in: "Handled by" },
  requests: { out: "Requests", in: "Requested by" },
  reads: { out: "Reads", in: "Read by" },
  writes: { out: "Writes", in: "Written by" },
  similar_to: { out: "Similar to", in: "Similar to" },
};

function groupTitle(kind: string, direction: "in" | "out"): string {
  const t = GROUP_TITLES[kind];
  if (t) return t[direction];
  const words = kind.replace(/_/g, " ");
  return direction === "out" ? words : `${words} (incoming)`;
}

interface Group {
  key: string;
  title: string;
  refs: NeighborRef[];
}

export function groupNeighbors(neighbors: NodeDetail["neighbors"]): Group[] {
  const groups = new Map<string, Group>();
  for (const [kind, refs] of Object.entries(neighbors)) {
    for (const ref of refs) {
      const key = `${kind}:${ref.direction}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, title: groupTitle(kind, ref.direction), refs: [] };
        groups.set(key, g);
      }
      g.refs.push(ref);
    }
  }
  // Structure (contains / part of) goes last; everything else keeps the server's order.
  const structural = (g: Group) => (g.key.startsWith("contains:") ? 1 : 0);
  return [...groups.values()].sort((a, b) => structural(a) - structural(b));
}

function GraphNodeFacts({ node, view }: { node: GraphNode; view: string | null }) {
  const stats = node.stats;
  const facts: [string, number][] = [];
  if (stats?.files !== undefined) facts.push(["Files", stats.files]);
  if (stats?.functions !== undefined) facts.push(["Functions", stats.functions]);
  if (stats?.loc !== undefined) facts.push(["Lines of code", stats.loc]);
  return (
    <section>
      <h3>About this node</h3>
      {node.kind === "more" && (
        <p>
          {node.size} more connected {node.size === 1 ? "function is" : "functions are"} hidden to keep the
          graph readable. Use fewer steps or narrower connection types to see them.
        </p>
      )}
      {node.kind === "external" && <p>An npm package. {node.size} of your files import it.</p>}
      {node.kind === "dir" && (
        <p>
          {view === "map-3d"
            ? "A folder. Switch the level to Files in the left panel to see the files inside it."
            : "A folder. Double-click it in the map to look inside."}
        </p>
      )}
      {facts.length > 0 && (
        <dl className="fan">
          {facts.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {node.badges && node.badges.length > 0 && (
        <ul className="badges" aria-label="Badges">
          {node.badges.map((b) => (
            <li key={b} className="badge">
              {b}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Inspector({ nodes }: { nodes: GraphNode[] }) {
  const { state, selectNode, openInView, view } = useStore();
  const id = state.route.sel;
  const known = id !== null && isServerNode(id);
  const { data: detail, loading, error } = useNodeDetail(known ? id : null);
  const [copied, setCopied] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the "Copied" flag when the node changes
  useEffect(() => setCopied(false), [id]);

  if (!id) return null;

  const hit = state.pickedHit?.id === id ? state.pickedHit : null;
  const graphNode = nodes.find((n) => n.id === id) ?? null;
  const current = detail && detail.node.id === id ? detail : null;
  const body = current?.node;

  const kind = body?.kind ?? hit?.kind ?? graphNode?.kind ?? null;
  const name =
    (body ? (body.kind === "file" ? baseName(body.name) : body.name) : undefined) ??
    hit?.name ??
    graphNode?.label ??
    shortLabel(id);
  const path = body?.path ?? hit?.path ?? graphNode?.path ?? null;
  const line = body?.line ?? hit?.line ?? null;
  const endLine = body?.endLine ?? (line !== null ? line + SOURCE_LINES - 1 : null);
  const isSymbol = id.startsWith("sym:");
  const isFile = id.startsWith("file:");
  const kindOfNode = graphNode?.kind ?? kind;
  const canMap = isSymbol || isFile || id.startsWith("ws:") || kindOfNode === "dir";
  const egoReady = state.meta?.views.some((v) => v.id === "ego" && v.enabled) ?? true;
  const mapReady = state.meta?.views.some((v) => v.id === "project-map" && v.enabled) ?? true;
  // A function is shown inside its file in the project map; folders, files and workspaces are shown as themselves.
  const mapTarget = isSymbol && path ? `file:${path}` : id;

  const copy = async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(line !== null ? `${path}:${line}` : path);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const groups = current ? groupNeighbors(current.neighbors) : [];
  const sourceRange: [number, number] | null =
    path && (isSymbol || isFile) && !(isSymbol && line === null)
      ? [line ?? 1, Math.min(endLine ?? SOURCE_LINES, (line ?? 1) + SOURCE_LINES - 1)]
      : null;

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div className="inspector-title">
          <h2 title={id}>{name}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close inspector"
            onClick={() => selectNode(null)}
          >
            ×
          </button>
        </div>
        {kind && <KindBadge kind={kind} />}
        {path && (
          <button type="button" className="path-btn" onClick={copy} title="Copy path and line">
            <code>
              {path}
              {line !== null && isSymbol ? `:${line}` : ""}
            </code>
            <span className="copy-state" role="status">
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
        )}
        <div className="inspector-actions">
          <button
            type="button"
            className="btn"
            disabled={!canMap || !mapReady}
            title={canMap ? "Show this in the project map" : "The project map cannot centre on this"}
            onClick={() => openInView("project-map", mapTarget, id)}
          >
            Open in project map
          </button>
          <button
            type="button"
            className="btn"
            disabled={!(isSymbol || isFile) || !egoReady}
            title={
              isSymbol || isFile
                ? "Show what uses this and what it uses"
                : "Callers and callees are available for functions and files"
            }
            onClick={() => openInView("ego", id, id)}
          >
            Show callers &amp; callees
          </button>
        </div>
      </div>

      {error && !current && known && (
        <p className="notice">
          Could not load the full details for this node ({error}). Showing what the view already knows.
        </p>
      )}
      {known && !current && loading && <p className="muted">Loading…</p>}

      <div className="inspector-body">
        {graphNode && !current && <GraphNodeFacts node={graphNode} view={view} />}

        {current && (
          <>
            {current.signature && (
              <section>
                <h3>Signature</h3>
                <pre className="signature">{current.signature}</pre>
              </section>
            )}

            <section>
              <h3>Description</h3>
              {current.untrusted_description ? (
                <div className="description">
                  <p className="description-label">Generated description — may be wrong</p>
                  {/* Plain text only. The string is untrusted and is never parsed as HTML. */}
                  <p className="description-text">{current.untrusted_description}</p>
                </div>
              ) : (
                <p className="muted">Not yet described</p>
              )}
            </section>

            {isSymbol && (
              <section>
                <h3>Details</h3>
                <dl className="fan">
                  {body?.exported !== undefined && (
                    <div>
                      <dt>Exported</dt>
                      <dd>{body.exported ? "Yes" : "No"}</dd>
                    </div>
                  )}
                  {body?.loc !== undefined && (
                    <div>
                      <dt>Lines</dt>
                      <dd>{body.loc}</dd>
                    </div>
                  )}
                  {body?.complexity !== undefined && (
                    <div>
                      <dt>Complexity</dt>
                      <dd>{body.complexity}</dd>
                    </div>
                  )}
                </dl>
              </section>
            )}

            <section>
              <h3>Connections</h3>
              <dl className="fan">
                <div>
                  <dt>Used by</dt>
                  <dd>{current.fan_in}</dd>
                </div>
                <div>
                  <dt>Uses</dt>
                  <dd>{current.fan_out}</dd>
                </div>
              </dl>
              {groups.length === 0 && <p className="muted">Nothing is connected to this node.</p>}
              {groups.map((g) => (
                <div className="neighbor-group" key={g.key}>
                  <h4>
                    {g.title} <span className="count">{g.refs.length}</span>
                  </h4>
                  <ul>
                    {g.refs.map((ref) => (
                      <li key={`${ref.direction}:${ref.id}`}>
                        <button
                          type="button"
                          className="link-btn"
                          title={ref.id}
                          onClick={() => selectNode(ref.id)}
                        >
                          {ref.label}
                        </button>
                        {ref.count > 1 && <span className="count"> ×{ref.count}</span>}
                        {ref.confidence === "low" && <span className="tag-low"> uncertain</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          </>
        )}

        {!graphNode && !current && !loading && !known && (
          <p className="muted">This node is not part of the current view, so there is little to show.</p>
        )}

        {sourceRange && path && (
          <section>
            <h3>Source</h3>
            <SourcePreview path={path} start={sourceRange[0]} end={sourceRange[1]} />
          </section>
        )}
      </div>
    </aside>
  );
}
