import { useMemo, useState } from "react";
import type { Scheme } from "../theme.ts";
import type { TreeNode } from "./hierarchy.ts";
import type { Scene } from "./scene.ts";
import { kindColor, workspaceColor } from "./style.ts";
import type { Level } from "./zoom.ts";

const MAX_WORKSPACES = 14;

/** Colour key: workspace colours (far and mid zoom) and kind colours (symbol zoom). */
export function Legend({ scene, scheme, level }: { scene: Scene; scheme: Scheme; level: Level }) {
  const [open, setOpen] = useState(true);
  const workspaces = useMemo(
    () =>
      scene.hierarchical
        ? scene.roots.map((r) => ({
            id: (scene.tree.nodes[r] as TreeNode).id,
            label: scene.nodes[r]?.label ?? "",
            color: workspaceColor(scene.rootRank.get(r) ?? 0, scheme),
          }))
        : [],
    [scene, scheme],
  );
  const kinds = useMemo(() => {
    const seen = new Set<string>();
    scene.tree.nodes.forEach((n) => {
      if (n.children.length === 0 && (!scene.hierarchical || n.tier >= 3)) seen.add(n.kind);
    });
    return [...seen].sort().slice(0, 10);
  }, [scene]);

  return (
    <aside className="gc-legend" aria-label="Legend">
      <button
        type="button"
        className="gc-legend-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Legend {open ? "−" : "+"}
      </button>
      {open && (
        <div className="gc-legend-body">
          {workspaces.length > 0 && (
            <section aria-label="Workspace colours" className={level === "near" ? "is-muted" : ""}>
              <h4>Workspaces</h4>
              <ul>
                {workspaces.slice(0, MAX_WORKSPACES).map((w) => (
                  <li key={w.id}>
                    <span className="gc-swatch" style={{ background: w.color }} aria-hidden="true" />
                    {w.label}
                  </li>
                ))}
                {workspaces.length > MAX_WORKSPACES && <li>+{workspaces.length - MAX_WORKSPACES} more</li>}
              </ul>
            </section>
          )}
          {kinds.length > 0 && (
            <section
              aria-label="Kind colours"
              className={workspaces.length > 0 && level !== "near" ? "is-muted" : ""}
            >
              <h4>{workspaces.length > 0 ? "Symbol kinds (zoomed in)" : "Kinds"}</h4>
              <ul>
                {kinds.map((k) => (
                  <li key={k}>
                    <span
                      className="gc-swatch round"
                      style={{ background: kindColor(k, scheme) }}
                      aria-hidden="true"
                    />
                    {k}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
