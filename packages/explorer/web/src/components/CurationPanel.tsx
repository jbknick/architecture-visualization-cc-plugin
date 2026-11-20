import {
  Cancel01Icon,
  Delete02Icon,
  EyeIcon,
  PaintBoardIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { api, type Group, type Selector, type ViewData } from "../api.ts";
import { describeSelector } from "../curation.ts";
import { useOverlay } from "../overlayStore.ts";
import { rankView } from "../rankedFiles/store.ts";
import { useStore } from "../store.tsx";
import { NameDialog } from "./NameDialog.tsx";
import { Button } from "./ui/button.tsx";

/** What a node id stands for, without its kind and repo prefix: `file:repo:a/b.ts` becomes `a/b.ts`. */
export function nodeName(id: string): string {
  const m = /^(?:file|sym|route|ep|table|mw|call):[^:]*:(.*)$/.exec(id);
  if (m?.[1]) return m[1];
  return id.replace(/^(?:ws|dir):/, "");
}

/**
 * Hovering a group lights its first file on the map with the highlight the "Largest files" list uses (`rankView`).
 * That highlight draws one file; the other members are not marked.
 */
function hoverGroup(members: string[] | undefined) {
  rankView.setHoverFile(members?.find((m) => m.startsWith("file:")) ?? null);
}

/**
 * The Curation section of the left panel: every label, hidden entry and group, each with its undo. Counts of group
 * members are the view's (`overlay.groups[].members`), so a member that this view does not show is not counted.
 */
export function CurationPanel({ data }: { data?: ViewData | null }) {
  const { writeOverlay } = useStore();
  const overlay = useOverlay();
  const [renaming, setRenaming] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!overlay) return null;

  const run = async (write: () => Promise<unknown>) => {
    setError(null);
    try {
      await writeOverlay(write);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const showAgain = (at: number) =>
    run(() => api.putHidden(overlay.hidden.filter((_, i) => i !== at) as Selector[]));
  const membersOf = (id: string) => data?.overlay?.groups.find((g) => g.id === id)?.members;
  const empty = overlay.labels.length === 0 && overlay.hidden.length === 0 && overlay.groups.length === 0;

  return (
    <section aria-label="Curation" className="curation">
      <h2 className="panel-title">
        <HugeiconsIcon icon={PaintBoardIcon} size={14} aria-hidden="true" />
        Curation
      </h2>
      {empty && (
        <p className="muted">
          Nothing renamed, hidden or grouped yet. Open a node and use Rename, Hide or Group.
        </p>
      )}
      {overlay.labels.length > 0 && (
        <div>
          <h3>Names</h3>
          <ul className="curation-list" aria-label="Names">
            {overlay.labels.map((l) => (
              <li key={l.nodeId}>
                <span className="curation-text" title={l.nodeId}>
                  <strong>{l.text}</strong>
                  <code>{nodeName(l.nodeId)}</code>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove name ${l.text}`}
                  title="Remove this name"
                  onClick={() => void run(() => api.putLabel(l.nodeId, ""))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {overlay.hidden.length > 0 && (
        <div>
          <h3>Hidden</h3>
          <ul className="curation-list" aria-label="Hidden">
            {overlay.hidden.map((s, i) => {
              const text = s.type === "ids" ? s.ids.map(nodeName).join(", ") : describeSelector(s);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the hidden list has no ids of its own and is rewritten whole
                <li key={i}>
                  <span className="curation-text" title={text}>
                    <code>{text}</code>
                  </span>
                  <Button type="button" variant="outline" size="xs" onClick={() => void showAgain(i)}>
                    <HugeiconsIcon icon={EyeIcon} size={12} aria-hidden="true" />
                    Show again
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {overlay.groups.length > 0 && (
        <div>
          <h3>Groups</h3>
          <ul className="curation-list" aria-label="Groups">
            {overlay.groups.map((g) => {
              const n = membersOf(g.id)?.length;
              return (
                <li
                  key={g.id}
                  onMouseEnter={() => hoverGroup(membersOf(g.id))}
                  onMouseLeave={() => hoverGroup(undefined)}
                >
                  <span className="curation-text">
                    <strong>{g.name}</strong>
                    <span className="muted">
                      {n === undefined ? "" : `${n} ${n === 1 ? "member" : "members"}`}
                    </span>
                  </span>
                  <span className="curation-buttons">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Rename group ${g.name}`}
                      title="Rename this group"
                      onClick={() => setRenaming(g)}
                    >
                      <HugeiconsIcon icon={PencilEdit01Icon} size={12} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete group ${g.name}`}
                      title="Delete this group"
                      onClick={() => void run(() => api.deleteGroup(g.id))}
                    >
                      <HugeiconsIcon icon={Delete02Icon} size={12} aria-hidden="true" />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="muted">Hover a group to mark its first file on the map. Only that one is marked.</p>
        </div>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <NameDialog
        open={renaming !== null}
        title="Rename group"
        confirm="Rename"
        initial={renaming?.name ?? ""}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => {
          const group = renaming;
          if (!group) return Promise.resolve();
          return writeOverlay(() => api.putGroup({ ...group, name }));
        }}
      />
    </section>
  );
}
