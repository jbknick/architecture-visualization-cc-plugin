import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DupCluster, type DuplicatesData, type DupMember, type DupWorkspace } from "../api.ts";
import { RELOAD_VIEW_EVENT } from "../hooks.ts";
import type { CanvasProps } from "../slots.ts";
import { useStore } from "../store.tsx";
import { currentScheme } from "../theme.ts";
import { workspaceColorAt } from "../workspacePalette.ts";
import { DupCompare } from "./DupCompare.tsx";
import {
  copiesLine,
  nameLine,
  overviewLine,
  pairsToDismiss,
  percent,
  plural,
  skippedBanner,
  splitLabel,
  TIER_WORDS,
  workspaceName,
} from "./dupModel.ts";

type ColorOf = (workspaceId: string | null) => string;

function useWorkspaceLookup(workspaces: DupWorkspace[]) {
  return useMemo(() => {
    const scheme = currentScheme();
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const index = new Map(workspaces.map((w, i) => [w.id, i]));
    const colorOf: ColorOf = (id) => {
      const i = id === null ? undefined : index.get(id);
      return i === undefined ? "var(--muted)" : workspaceColorAt(i, scheme);
    };
    return { byId, colorOf };
  }, [workspaces]);
}

function TierBadge({ tier }: { tier: DupCluster["tier"] }) {
  return (
    <span className={`dup-tier dup-tier-${tier}`} title={TIER_WORDS[tier].hint}>
      {TIER_WORDS[tier].label}
    </span>
  );
}

function Dots({
  ids,
  colorOf,
  byId,
}: {
  ids: string[];
  colorOf: ColorOf;
  byId: ReadonlyMap<string, DupWorkspace>;
}) {
  return (
    <span className="dup-dots">
      {ids.slice(0, 5).map((id) => (
        <span
          key={id}
          className="kind-dot"
          style={{ background: colorOf(id) }}
          title={workspaceName(id, byId)}
          role="img"
          aria-label={workspaceName(id, byId)}
        />
      ))}
    </span>
  );
}

// ---- overview strip ---------------------------------------------------------------------------------------------

function Overview({
  data,
  byId,
  colorOf,
}: {
  data: DuplicatesData;
  byId: ReadonlyMap<string, DupWorkspace>;
  colorOf: ColorOf;
}) {
  const { summary, splits } = data;
  const shown = splits.slice(0, 6);
  const other = splits.slice(6).reduce((s, x) => s + x.clusters, 0);
  const within = summary.clusters - summary.crossWorkspace;
  return (
    <section className="dup-overview" aria-label="Overview">
      <p className="dup-overview-line">{overviewLine(summary)}</p>
      {summary.clusters > 0 && (
        <>
          <p className="dup-overview-sub">
            <strong>{plural(summary.crossWorkspace, "group")}</strong> span more than one workspace (the ones
            worth moving to a shared package) and <strong>{within}</strong> sit inside one.
          </p>
          <ul className="dup-bar" aria-label="Groups by workspace">
            {shown.map((s) => {
              const cross = s.workspaces.length > 1;
              const label = `${splitLabel(s, byId)}: ${plural(s.clusters, "group")}`;
              return (
                <li
                  key={s.workspaces.join("|")}
                  className={`dup-bar-seg ${cross ? "is-cross" : "is-within"}`}
                  style={{ flexGrow: s.clusters, flexBasis: 0 }}
                  title={label}
                >
                  <span
                    className="dup-bar-fill"
                    style={cross ? undefined : { background: colorOf(s.workspaces[0] ?? null) }}
                  />
                </li>
              );
            })}
            {other > 0 && (
              <li
                className="dup-bar-seg is-other"
                style={{ flexGrow: other, flexBasis: 0 }}
                title={`Others: ${other}`}
              >
                <span className="dup-bar-fill" />
              </li>
            )}
          </ul>
          <ul className="dup-bar-legend">
            {shown.map((s) => (
              <li key={s.workspaces.join("|")} className={s.workspaces.length > 1 ? "is-cross" : undefined}>
                <span
                  className="dup-swatch"
                  style={
                    s.workspaces.length > 1 ? undefined : { background: colorOf(s.workspaces[0] ?? null) }
                  }
                  aria-hidden="true"
                />
                {splitLabel(s, byId)} <span className="muted">{s.clusters}</span>
              </li>
            ))}
            {other > 0 && <li className="muted">+ {plural(other, "group")} in other pairs</li>}
          </ul>
        </>
      )}
    </section>
  );
}

// ---- the ranked list -------------------------------------------------------------------------------------------

function ClusterList({
  clusters,
  selectedId,
  onSelect,
  byId,
  colorOf,
}: {
  clusters: DupCluster[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  byId: ReadonlyMap<string, DupWorkspace>;
  colorOf: ColorOf;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const at = clusters.findIndex((c) => c.id === selectedId);
    const next = clusters[Math.max(0, Math.min(clusters.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    onSelect(next.id);
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-cluster="${CSS.escape(next.id)}"]`)?.focus(),
    );
  };
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: arrow keys move between the row buttons
    <ul className="dup-list" aria-label="Duplicate groups, biggest first" ref={listRef} onKeyDown={move}>
      {clusters.map((c, i) => (
        <li key={c.id}>
          <button
            type="button"
            className={`dup-row ${c.id === selectedId ? "is-active" : ""}`}
            data-cluster={c.id}
            aria-current={c.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(c.id)}
          >
            <span className="dup-row-top">
              <span className="dup-rank" aria-hidden="true">
                {i + 1}
              </span>
              <TierBadge tier={c.tier} />
              <Dots ids={c.workspaces} colorOf={colorOf} byId={byId} />
            </span>
            <span className="dup-row-names">{nameLine(c)}</span>
            <span className="dup-row-meta">{copiesLine(c)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---- the selected group ----------------------------------------------------------------------------------------

function CopyPath({ member }: { member: DupMember }) {
  const [copied, setCopied] = useState(false);
  const text = `${member.path}:${member.line}`;
  return (
    <button
      type="button"
      className="dup-path"
      title="Copy path and line"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      <code>{text}</code>
      <span className="dup-copied" role="status">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

function DismissForm({
  member,
  busy,
  onConfirm,
  onCancel,
}: {
  member: DupMember;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="dup-dismiss"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(reason.trim());
      }}
    >
      <label>
        <span>Why is {member.name} not a duplicate? (optional)</span>
        <input
          type="text"
          value={reason}
          maxLength={200}
          // biome-ignore lint/a11y/noAutofocus: the field was just opened by the user's click
          autoFocus
          placeholder="For example: same shape, different business rule"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <p className="muted">The pair is hidden from now on, here and in the duplicate check in Claude Code.</p>
      <div className="dup-actions">
        <button type="submit" className="btn dup-btn-primary" disabled={busy}>
          Hide this pair
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function MemberCard({
  member,
  cluster,
  selected,
  dismissing,
  busy,
  byId,
  colorOf,
  onSelect,
  onStartDismiss,
  onCancelDismiss,
  onDismiss,
}: {
  member: DupMember;
  cluster: DupCluster;
  selected: boolean;
  dismissing: boolean;
  busy: boolean;
  byId: ReadonlyMap<string, DupWorkspace>;
  colorOf: ColorOf;
  onSelect: () => void;
  onStartDismiss: () => void;
  onCancelDismiss: () => void;
  onDismiss: (reason: string) => void;
}) {
  const { openInView, state } = useStore();
  const hasView = (id: string) => state.meta?.views.some((v) => v.id === id && v.enabled) ?? true;
  const pct = percent(member.score, member.tier);
  return (
    <li
      className={`dup-card ${member.keep ? "is-keep" : ""} ${selected ? "is-selected" : ""}`}
      data-member={member.id}
    >
      <div className="dup-card-head">
        <h4 className="dup-card-name">
          {member.name}
          <span className="dup-kind">{member.kind}</span>
        </h4>
        {member.keep ? (
          <span className="dup-keep-tag">Keep this one</span>
        ) : (
          pct && (
            <span className="dup-sim" title={member.tier ? TIER_WORDS[member.tier].hint : undefined}>
              {pct} the same as the one to keep
            </span>
          )
        )}
      </div>
      <CopyPath member={member} />
      <p className="dup-facts">
        <span className="kind-dot" style={{ background: colorOf(member.workspaceId) }} aria-hidden="true" />
        {workspaceName(member.workspaceId, byId)}
        <span aria-hidden="true"> · </span>
        {member.exported ? "exported" : "not exported"}
        <span aria-hidden="true"> · </span>
        {member.fanIn === 0 ? "no callers" : plural(member.fanIn, "caller")}
        <span aria-hidden="true"> · </span>
        {plural(member.loc, "line")}
      </p>
      {member.keep && <p className="dup-reason">{cluster.keepReason}</p>}
      {!member.keep && member.advice && <p className="dup-advice">{member.advice.action}</p>}
      {dismissing ? (
        <DismissForm member={member} busy={busy} onConfirm={onDismiss} onCancel={onCancelDismiss} />
      ) : (
        <div className="dup-actions">
          {!member.keep && (
            <button type="button" className="btn" onClick={onStartDismiss}>
              Not a duplicate
            </button>
          )}
          {!member.keep && !selected && (
            <button type="button" className="btn" onClick={onSelect}>
              Compare
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={!hasView("ego")}
            onClick={() => openInView("ego", member.id, member.id)}
          >
            Show callers
          </button>
          <button
            type="button"
            className="btn"
            disabled={!hasView("project-map")}
            onClick={() => openInView("project-map", `file:${member.path}`, member.id)}
          >
            Open in project map
          </button>
        </div>
      )}
    </li>
  );
}

function ClusterDetail({
  cluster,
  byId,
  colorOf,
  onChanged,
}: {
  cluster: DupCluster;
  byId: ReadonlyMap<string, DupWorkspace>;
  colorOf: ColorOf;
  onChanged: (message: string) => void;
}) {
  const keep = cluster.members.find((m) => m.keep) ?? (cluster.members[0] as DupMember);
  const others = cluster.members.filter((m) => !m.keep);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new group starts with a clean slate
  useEffect(() => {
    setPickedId(null);
    setDismissingId(null);
    setError(null);
  }, [cluster.id]);
  const picked = others.find((m) => m.id === pickedId) ?? others[0];

  const dismissMember = async (member: DupMember, reason: string) => {
    setBusy(true);
    setError(null);
    try {
      let last = null;
      for (const [a, b] of pairsToDismiss(cluster, member)) last = await api.dismiss(a, b, reason);
      setDismissingId(null);
      onChanged(
        `${member.name} is no longer listed as a duplicate. ${last ? plural(last.summary.clusters, "group") : "The groups"} left.`,
      );
      window.dispatchEvent(new Event(RELOAD_VIEW_EVENT));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const names = [...new Set(cluster.members.map((m) => m.name))];
  return (
    <div className="dup-detail" data-testid="dup-detail">
      <header className="dup-detail-head">
        <div className="dup-detail-title">
          <TierBadge tier={cluster.tier} />
          <h2>
            {names.slice(0, 3).join(" · ")}
            {names.length > 3 ? ` +${names.length - 3} more` : ""}
          </h2>
        </div>
        <p className="muted">
          {copiesLine(cluster)}. {TIER_WORDS[cluster.tier].hint}
        </p>
      </header>
      {error && (
        <p className="dup-error" role="alert">
          Could not save that: {error}
        </p>
      )}
      <ul className="dup-cards" aria-label="Copies in this group">
        {cluster.members.map((m) => (
          <MemberCard
            key={m.id}
            member={m}
            cluster={cluster}
            selected={!m.keep && m.id === picked?.id}
            dismissing={dismissingId === m.id}
            busy={busy}
            byId={byId}
            colorOf={colorOf}
            onSelect={() => setPickedId(m.id)}
            onStartDismiss={() => setDismissingId(m.id)}
            onCancelDismiss={() => setDismissingId(null)}
            onDismiss={(reason) => dismissMember(m, reason)}
          />
        ))}
      </ul>
      {picked && <DupCompare key={`${keep.id}|${picked.id}`} keep={keep} other={picked} />}
    </div>
  );
}

// ---- the canvas --------------------------------------------------------------------------------------------------

/** Master/detail for the duplicates view: ranked groups on the left, the selected group's copies and a source comparison on the right. */
export function DuplicatesCanvas({ data }: CanvasProps) {
  const clusters = data?.clusters ?? [];
  const workspaces = data?.workspaces ?? [];
  const { byId, colorOf } = useWorkspaceLookup(workspaces);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lastIndex = useRef(0);

  // Keep a valid selection: the first group at the start, and the next one along after a group disappears.
  useEffect(() => {
    if (clusters.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId === null || !clusters.some((c) => c.id === selectedId)) {
      setSelectedId((clusters[Math.min(lastIndex.current, clusters.length - 1)] as DupCluster).id);
    }
  }, [clusters, selectedId]);

  const select = useCallback(
    (id: string) => {
      lastIndex.current = Math.max(
        0,
        clusters.findIndex((c) => c.id === id),
      );
      setSelectedId(id);
      setNotice(null);
    },
    [clusters],
  );

  if (!data?.clusters || !data.summary) {
    return <p className="empty">Loading duplicates…</p>;
  }
  const selected = clusters.find((c) => c.id === selectedId) ?? null;
  const banner = skippedBanner(data.skipped);

  return (
    <div className="dup-canvas" data-testid="duplicates-canvas">
      {banner && (
        <p className="dup-banner" role="note">
          {banner}
        </p>
      )}
      <Overview data={data as DuplicatesData} byId={byId} colorOf={colorOf} />
      {notice && (
        <p className="dup-notice" role="status">
          {notice}
        </p>
      )}
      {clusters.length === 0 ? (
        <div className="dup-empty">
          <h2>No duplicates found</h2>
          <p>
            Nothing here looks like a copy of something else. If you expected results, check the filters on
            the left: tests are hidden by default, and each tier can be switched off.
          </p>
          {banner && <p className="muted">Only identical and nearly identical code was checked.</p>}
        </div>
      ) : (
        <div className="dup-split">
          <ClusterList
            clusters={clusters}
            selectedId={selectedId}
            onSelect={select}
            byId={byId}
            colorOf={colorOf}
          />
          {selected && (
            <ClusterDetail cluster={selected} byId={byId} colorOf={colorOf} onChanged={setNotice} />
          )}
        </div>
      )}
    </div>
  );
}
