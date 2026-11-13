import { useEffect, useState } from "react";
import type { GraphNode } from "../api.ts";
import { useNodeDetail } from "../hooks.ts";
import { useStore } from "../store.tsx";
import { KindBadge } from "./KindBadge.tsx";
import { SourcePreview } from "./SourcePreview.tsx";

const SOURCE_LINES = 40;

function shortLabel(id: string, byId: Map<string, GraphNode>): string {
  const known = byId.get(id)?.label;
  if (known) return known;
  const afterHash = id.split("#").pop() ?? id;
  return afterHash.split(/[:/]/).pop() ?? id;
}

export function Inspector({ nodes }: { nodes: GraphNode[] }) {
  const { state, focusNode } = useStore();
  const id = state.route.focus;
  const { data: detail, loading, error } = useNodeDetail(id);
  const [copied, setCopied] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the "Copied" flag when the node changes
  useEffect(() => setCopied(false), [id]);

  if (!id) return null;

  const hit = state.pickedHit?.id === id ? state.pickedHit : null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const current = detail && detail.node.id === id ? detail : null;
  const name = current?.node.label ?? hit?.name ?? byId.get(id)?.label ?? shortLabel(id, byId);
  const kind = current?.node.kind ?? hit?.kind ?? byId.get(id)?.kind ?? null;
  const path = current?.path ?? hit?.path ?? null;
  const line = current?.line ?? hit?.line ?? null;
  const endLine = current?.end_line ?? (line !== null ? line + SOURCE_LINES - 1 : null);

  const copy = async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(line !== null ? `${path}:${line}` : path);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const neighborKinds = current
    ? Object.keys(current.neighbors)
        .filter((k) => (current.neighbors[k]?.length ?? 0) > 0)
        .sort()
    : [];

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div className="inspector-title">
          <h2 title={id}>{name}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close inspector"
            onClick={() => focusNode(null)}
          >
            ×
          </button>
        </div>
        {kind && <KindBadge kind={kind} />}
        {path && (
          <button type="button" className="path-btn" onClick={copy} title="Copy path and line">
            <code>
              {path}
              {line !== null ? `:${line}` : ""}
            </code>
            <span className="copy-state" role="status">
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
        )}
      </div>

      {error && !current && <p className="notice">Could not load this node ({error}).</p>}
      {!current && loading && <p className="muted">Loading…</p>}

      {current && (
        <div className="inspector-body">
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
                {current.provenance && (
                  <p className="provenance">
                    Source: {current.provenance.source}
                    {current.provenance.model ? ` (${current.provenance.model})` : ""}
                  </p>
                )}
              </div>
            ) : (
              <p className="muted">Not yet described</p>
            )}
          </section>

          <section>
            <h3>Connections</h3>
            <dl className="fan">
              <div>
                <dt>Fan-in</dt>
                <dd>{current.fan_in}</dd>
              </div>
              <div>
                <dt>Fan-out</dt>
                <dd>{current.fan_out}</dd>
              </div>
            </dl>
            {neighborKinds.length === 0 && <p className="muted">No neighbors.</p>}
            {neighborKinds.map((k) => (
              <div className="neighbor-group" key={k}>
                <h4>
                  {k.replace(/_/g, " ")} <span className="count">{current.neighbors[k]?.length ?? 0}</span>
                </h4>
                <ul>
                  {(current.neighbors[k] ?? []).map((nid) => (
                    <li key={nid}>
                      <button type="button" className="link-btn" title={nid} onClick={() => focusNode(nid)}>
                        {shortLabel(nid, byId)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          {path && line !== null && endLine !== null && (
            <section>
              <h3>Source</h3>
              <SourcePreview path={path} start={line} end={endLine} />
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
