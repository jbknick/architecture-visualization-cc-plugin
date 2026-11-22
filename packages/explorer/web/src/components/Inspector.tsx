import { Cancel01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type {
  EndpointFacts,
  GraphNode,
  NeighborRef,
  NodeDetail,
  NodeRef,
  ReviewChange,
  ReviewConsumers,
  ReviewData,
  TableFacts,
} from "../api.ts";
import { m2Of, m2Spec } from "../badges.ts";
import { descriptionLabel } from "../descriptionLabel.ts";
import { useNodeDetail, useOverview } from "../hooks.ts";
import { fileIdBeside, isFileId, isSymId, nameOfSymId } from "../ids.ts";
import { useOverlay } from "../overlayStore.ts";
import { useStore } from "../store.tsx";
import { isServerNode } from "../views/drill.ts";
import { expandedIds, withExpanded } from "../views/egoGroups.ts";
import { ConsumerTiers } from "../views/ReviewConsumers.tsx";
import { reviewFocus } from "../views/reviewFocus.ts";
import { CHANGE_WORDS, markKindOf } from "../views/reviewModel.ts";
import { CurationActions } from "./CurationActions.tsx";
import { KindBadge } from "./KindBadge.tsx";
import { SourcePreview } from "./SourcePreview.tsx";
import { Button } from "./ui/button.tsx";

const SOURCE_LINES = 40;

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** A readable name for an id nobody told us about, e.g. `sym:pnpm-turbo:a/b.ts#Foo` becomes `Foo`. */
function shortLabel(id: string): string {
  const named = nameOfSymId(id);
  if (named !== undefined) return named;
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

/** The members of an ego group node. Selecting one expands the group (if needed) and opens the member. */
function GroupMembers({ node }: { node: GraphNode }) {
  const { state, navigate } = useStore();
  const members = node.members ?? [];
  const side = node.side === "in" ? "callers" : "callees";
  const open = (id: string) => {
    const filters = node.expanded
      ? state.route.filters
      : withExpanded(state.route.filters, [...expandedIds(state.route.filters), node.id]);
    navigate({ sel: id, filters });
  };
  return (
    <section aria-label="Group members">
      <h3>
        {members.length} {members.length === 1 ? side.slice(0, -1) : side}
      </h3>
      <p className="muted">
        {node.expanded
          ? "This group is expanded: its members are shown one by one."
          : "Pick a member to open this group and see that member's details."}
      </p>
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.id}>
            <button type="button" className="link-btn" title={m.id} onClick={() => open(m.id)}>
              {m.label}
            </button>
            {m.path && (
              <code className="member-path">
                {m.path}
                {m.line !== undefined ? `:${m.line}` : ""}
              </code>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function GraphNodeFacts({ node, view }: { node: GraphNode; view: string | null }) {
  const stats = node.stats;
  const facts: [string, number][] = [];
  if (stats?.files !== undefined) facts.push(["Files", stats.files]);
  if (stats?.members !== undefined) facts.push(["Members", stats.members]);
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
      {node.kind === "group" && <GroupMembers node={node} />}
      {node.badges && node.badges.length > 0 && (
        <ul className="badges" aria-label="Badges">
          {node.badges.map((b) => (
            <li key={b} className={`badge${m2Spec(b) ? ` badge-${b}` : ""}`} title={m2Spec(b)?.help}>
              {b}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Workspaces and folders only: the cached overview if there is one that is still current, else a hint. Overviews are
 * written only on request (`/gantry:overview`), never by the explorer. The text is untrusted, shown as plain text.
 */
function OverviewSection({ id }: { id: string }) {
  const { data, loading, error } = useOverview(id);
  const text = data ? data.untrusted_overview : null;
  return (
    <section aria-label="Overview">
      <h3>Overview</h3>
      {text ? (
        <div className="description">
          <p className="description-label">Overview — generated, may be wrong</p>
          {/* Plain text only. The string is untrusted and is never parsed as HTML. */}
          <p className="description-text">{text}</p>
        </div>
      ) : loading && !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <p className="muted">
          {error
            ? "Could not load the overview. "
            : data?.stale
              ? "The saved overview is out of date because code inside changed. "
              : "No overview yet. "}
          Run <code>/gantry:overview {id}</code> in Claude Code
          {data?.stale ? " to write a new one." : "."}
        </p>
      )}
    </section>
  );
}

/**
 * Review view: "Used by (n)", the consumers of the selected change or changed file in two tiers (#169). Picking one
 * selects it and keeps this change in focus on the map.
 */
function UsedBySection({ id, consumers }: { id: string; consumers: ReviewConsumers }) {
  const { selectNode, state } = useStore();
  return (
    <section aria-label="Used by" className="rv-change rv-used-by">
      <h3>Used by ({consumers.directTotal + consumers.potentialTotal + consumers.reachableTotal})</h3>
      <ConsumerTiers
        consumers={consumers}
        label="Consumers in two tiers"
        sel={state.route.sel}
        onPick={(c) => {
          reviewFocus.set(id);
          selectNode(c);
        }}
      />
    </section>
  );
}

/** Review view: how the selected symbol changed, with the signature before and after. */
function ReviewChangeSection({ change }: { change: ReviewChange }) {
  const { before, after } = change;
  const where = (s: { path: string; line: number }) => `${s.path}:${s.line}`;
  const moved = before && after && where(before) !== where(after);
  return (
    <section aria-label="Change in this review" className="rv-change">
      <h3>Change in this review</h3>
      <p>
        <span className={`rv-dot rv-mark-${markKindOf(change)}`} />{" "}
        <strong>{CHANGE_WORDS[change.kind].label}</strong>
        {change.signatureChanged ? ", signature changed" : ""}
        {change.exportedChanged ? (after?.exported ? ", now exported" : ", no longer exported") : ""}
        {change.locDelta !== 0 ? `, ${change.locDelta > 0 ? "+" : ""}${change.locDelta} lines` : ""}
      </p>
      {before && (
        <div>
          <h4>Before{moved ? ` (${where(before)})` : ""}</h4>
          <pre className="signature" data-side="before">
            {before.signature}
          </pre>
        </div>
      )}
      {after && (
        <div>
          <h4>After{moved ? ` (${where(after)})` : ""}</h4>
          <pre className="signature" data-side="after">
            {after.signature}
          </pre>
        </div>
      )}
      <p className="muted">
        {change.callers === 0
          ? "Nothing in the index uses it directly."
          : `${change.callers} direct ${change.callers === 1 ? "consumer" : "consumers"} (tinted on the map, with a line to this change).`}
      </p>
      {change.untrusted_description && (
        <div className="description">
          <p className="description-label">{descriptionLabel(change.described_by)}</p>
          {/* Plain text only. The string is untrusted and is never parsed as HTML. */}
          <p className="description-text">{change.untrusted_description}</p>
        </div>
      )}
    </section>
  );
}

/**
 * Key/value facts of an adapter node (#48): one row per fact, the key in a narrow column and the value wrapping in
 * the rest of the width (the `.fan` stat tiles are for short numbers only).
 */
function Facts({ label, rows }: { label: string; rows: [string, React.ReactNode][] }) {
  return (
    <dl className="kv-facts" aria-label={label}>
      {rows.map(([k, v]) => (
        <div className="kv-row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function RefLinks({ refs }: { refs: NodeRef[] }) {
  const { selectNode } = useStore();
  if (refs.length === 0) return <>none</>;
  return (
    <>
      {refs.map((t, i) => (
        <span key={t.id}>
          {i > 0 ? ", " : ""}
          <button type="button" className="link-btn" title={t.id} onClick={() => selectNode(t.id)}>
            {t.label}
          </button>
        </span>
      ))}
    </>
  );
}

/** Endpoints (#48): what it answers, what handles it, what it passes through and which tables it touches. */
function EndpointSection({ facts }: { facts: EndpointFacts }) {
  const rows: [string, React.ReactNode][] = [
    ["Kind", `${facts.group} (${facts.adapter})`],
    ["Method", facts.method],
    [facts.group === "server fn" ? "Name" : "Path", <code key="p">{facts.path}</code>],
  ];
  if (facts.rpcPath) rows.push(["Procedure", <code key="r">{facts.rpcPath}</code>]);
  rows.push([
    "Handler",
    facts.handler ? (
      <span key="h">
        <RefLinks refs={[facts.handler]} />
        {facts.handlerName === "inline" ? " (inline)" : ""}
      </span>
    ) : (
      "not resolved"
    ),
  ]);
  if (facts.middleware.length > 0) rows.push(["Middleware", facts.middleware.join(", ")]);
  rows.push(["Requested from", `${facts.requestedBy} ${facts.requestedBy === 1 ? "place" : "places"}`]);
  rows.push(
    ["Reads", <RefLinks key="r" refs={facts.reads} />],
    ["Writes", <RefLinks key="w" refs={facts.writes} />],
  );
  return (
    <section aria-label="Endpoint">
      <h3>Endpoint</h3>
      <Facts label="Endpoint facts" rows={rows} />
    </section>
  );
}

/** Tables (#48): columns, and how much code reads and writes it (the code itself is under Connections). */
function TableSection({ facts }: { facts: TableFacts }) {
  const rows: [string, React.ReactNode][] = [
    ["Writers", String(facts.writers)],
    ["Readers", String(facts.readers)],
  ];
  if (facts.dialect) rows.push(["Dialect", facts.dialect]);
  rows.push([
    `Columns (${facts.columns.length})`,
    <code key="c">{facts.columns.join(", ") || "none read"}</code>,
  ]);
  return (
    <section aria-label="Table">
      <h3>Table</h3>
      <Facts label="Table facts" rows={rows} />
      <p className="muted">Raw SQL is not read, so tables used only through it are missing.</p>
    </section>
  );
}

/** A middleware named by oRPC procedures or server functions (#48): the endpoints that use it. */
function MiddlewareRefSection({ facts }: { facts: { name: string; endpoints: NodeRef[] } }) {
  return (
    <section aria-label="Middleware">
      <h3>Middleware</h3>
      <Facts
        label="Middleware facts"
        rows={[
          ["Name", <code key="n">{facts.name}</code>],
          [`Used by (${facts.endpoints.length})`, <RefLinks key="u" refs={facts.endpoints} />],
        ]}
      />
    </section>
  );
}

export function Inspector({ nodes, review = null }: { nodes: GraphNode[]; review?: ReviewData | null }) {
  const { state, selectNode, openInView, view } = useStore();
  const overlay = useOverlay();
  const id = state.route.sel;
  const known = id !== null && isServerNode(id);
  const { data: detail, loading, error } = useNodeDetail(known ? id : null);
  const [copied, setCopied] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the "Copied" flag when the node changes
  useEffect(() => setCopied(false), [id]);

  if (!id) return null;

  const hit = state.pickedHit?.id === id ? state.pickedHit : null;
  const graphNode = nodes.find((n) => n.id === id) ?? null;
  const reviewChange = review?.changes.find((c) => c.id === id) ?? null;
  const reviewFile = review?.files.find((f) => f.id === id) ?? null;
  const usedBy = reviewChange?.consumers ?? reviewFile?.consumers ?? null;
  const current = detail && detail.node.id === id ? detail : null;
  const body = current?.node;

  const kind = body?.kind ?? hit?.kind ?? graphNode?.kind ?? null;
  const plainName =
    (body ? (body.kind === "file" ? baseName(body.name) : body.name) : undefined) ??
    hit?.name ??
    graphNode?.label ??
    shortLabel(id);
  // A person-set label replaces the name; the name it replaced stays visible under it.
  const labelText = overlay?.labels.find((l) => l.nodeId === id)?.text ?? null;
  const name = labelText ?? plainName;
  const labelOriginal = labelText === null ? null : (graphNode?.labelOriginal ?? plainName);
  const path = body?.path ?? hit?.path ?? graphNode?.path ?? null;
  const line = body?.line ?? hit?.line ?? null;
  const endLine = body?.endLine ?? (line !== null ? line + SOURCE_LINES - 1 : null);
  const isSymbol = isSymId(id);
  const isFile = isFileId(id);
  const kindOfNode = graphNode?.kind ?? kind;
  const isAdapter = /^(route|ep|table|mw|mwref|call):/.test(id);
  const canMap =
    isSymbol || isFile || id.startsWith("ws:") || kindOfNode === "dir" || (isAdapter && path !== null);
  // Only nodes the server knows as a workspace or a folder have an overview; the 3D map's own cluster ids do not.
  const hasOverview = id.startsWith("ws:") || (id.startsWith("dir:") && kindOfNode === "dir");
  const egoReady = state.meta?.views.some((v) => v.id === "ego" && v.enabled) ?? true;
  const mapReady = state.meta?.views.some((v) => v.id === "project-map" && v.enabled) ?? true;
  // A function is shown inside its file in the project map; folders, files and workspaces are shown as themselves.
  const mapTarget = (isSymbol || isAdapter) && path ? (fileIdBeside(id, path) ?? id) : id;
  const flowReady = (v: string) => state.meta?.views.some((x) => x.id === v && x.enabled) ?? true;

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
    path && (isSymbol || isFile) && !(isSymbol && line === null) && reviewChange?.kind !== "removed"
      ? [line ?? 1, Math.min(endLine ?? SOURCE_LINES, (line ?? 1) + SOURCE_LINES - 1)]
      : null;

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div className="inspector-title">
          <h2 title={id}>{name}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close inspector"
            onClick={() => selectNode(null)}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden="true" />
          </Button>
        </div>
        {labelOriginal !== null && (
          <p className="muted label-original">
            Original name: <code>{labelOriginal}</code>
          </p>
        )}
        {kind && <KindBadge kind={kind} />}
        {isSymbol && current && m2Of(graphNode?.badges).length > 0 && (
          <ul className="badges" aria-label="Function badges">
            {m2Of(graphNode?.badges).map((b) => (
              <li key={b.name} className={`badge badge-${b.name}`} title={b.help}>
                {b.name}
              </li>
            ))}
          </ul>
        )}
        {path && (
          <button type="button" className="path-btn" onClick={copy} title="Copy path and line">
            <code>
              {path}
              {line !== null && isSymbol ? `:${line}` : ""}
            </code>
            <span className="copy-state" role="status">
              <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} aria-hidden="true" />
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
        )}
        <div className="inspector-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canMap || !mapReady}
            title={canMap ? "Show this in the project map" : "The project map cannot centre on this"}
            onClick={() => openInView("project-map", mapTarget, id)}
          >
            Open in project map
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!(isSymbol || isFile) || !egoReady}
            title={
              isSymbol || isFile
                ? "Show what uses this and what it uses"
                : "Callers and callees are available for functions and files"
            }
            onClick={() => openInView("ego", id, id)}
          >
            Show callers &amp; callees
          </Button>
          {(kindOfNode === "route" || kindOfNode === "endpoint") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!flowReady("feature-path")}
              title="Follow this from the page to the tables"
              onClick={() => openInView("feature-path", id, id)}
            >
              Show feature path
            </Button>
          )}
          {kindOfNode === "table" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!flowReady("table-usage")}
              title="Who writes and reads this table"
              onClick={() => openInView("table-usage", id, id)}
            >
              Show table usage
            </Button>
          )}
        </div>
        <CurationActions id={id} />
      </div>

      {error && !current && known && !reviewChange && (
        <p className="notice">
          Could not load the full details for this node ({error}). Showing what the view already knows.
        </p>
      )}
      {known && !current && loading && <p className="muted">Loading…</p>}

      <div className="inspector-body">
        {reviewChange && <ReviewChangeSection change={reviewChange} />}
        {usedBy && <UsedBySection id={id} consumers={usedBy} />}
        {hasOverview && <OverviewSection id={id} />}
        {graphNode && !current && !reviewChange && <GraphNodeFacts node={graphNode} view={view} />}

        {current && (
          <>
            {body?.endpoint && <EndpointSection facts={body.endpoint} />}
            {body?.table && <TableSection facts={body.table} />}
            {body?.middlewareRef && <MiddlewareRefSection facts={body.middlewareRef} />}
            {current.signature && (
              <section>
                <h3>Signature</h3>
                <pre className="signature">{current.signature}</pre>
              </section>
            )}

            {!isAdapter && (
              <section>
                <h3>Description</h3>
                {current.untrusted_description ? (
                  <div className="description">
                    <p className="description-label">{descriptionLabel(current.described_by)}</p>
                    {/* Plain text only. The string is untrusted and is never parsed as HTML. */}
                    <p className="description-text">{current.untrusted_description}</p>
                  </div>
                ) : (
                  <p className="muted">Not yet described</p>
                )}
              </section>
            )}

            {(isSymbol || (isFile && body?.langLabel !== undefined)) && (
              <section>
                <h3>Details</h3>
                <dl className="fan">
                  {body?.langLabel !== undefined && (
                    <div>
                      <dt>Language</dt>
                      <dd>{body.langLabel}</dd>
                    </div>
                  )}
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
