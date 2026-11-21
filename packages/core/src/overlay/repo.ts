import type { Store } from "../store/index.js";
import { syncAnchors } from "./anchors.js";
import { defaultGroups } from "./defaults.js";
import {
  FilterSpecSchema,
  type Group,
  GroupSchema,
  type Label,
  LabelSchema,
  type OverlayState,
  type SavedView,
  SavedViewSchema,
  type Selector,
  SelectorSchema,
} from "./types.js";

/**
 * The only writer of the overlay's labels, hidden, groups, group_rules, views and anchors tables (spec section 9).
 * JSON is `JSON.stringify` of the zod-parsed value, so equal input gives equal bytes. Each write is one transaction.
 */

const HiddenSchema = SelectorSchema.array().max(50);

export function readOverlay(store: Store): OverlayState {
  const all = <T>(sql: string): T[] => store.db.prepare(sql).all() as T[];
  const labels = all<{ node_id: string; text: string }>(
    "SELECT node_id, text FROM overlay.labels ORDER BY node_id",
  ).map((r): Label => ({ nodeId: r.node_id, text: r.text }));
  const hidden = all<{ selector: string }>("SELECT selector FROM overlay.hidden ORDER BY position").map(
    (r): Selector => SelectorSchema.parse(JSON.parse(r.selector)),
  );
  const rules = new Map(
    all<{ group_id: string; may_use: string }>("SELECT group_id, may_use FROM overlay.group_rules").map(
      (r) => [r.group_id, JSON.parse(r.may_use) as string[]],
    ),
  );
  const groups = all<{ id: string; name: string; selectors: string }>(
    "SELECT id, name, selectors FROM overlay.groups ORDER BY id",
  ).map(
    (r): Group =>
      GroupSchema.parse({
        id: r.id,
        name: r.name,
        selectors: JSON.parse(r.selectors),
        mayUse: rules.get(r.id) ?? null,
      }),
  );
  const views = all<{ id: string; name: string; spec: string }>(
    "SELECT id, name, spec FROM overlay.views ORDER BY id",
  ).map((r): SavedView => SavedViewSchema.parse({ id: r.id, name: r.name, spec: JSON.parse(r.spec) }));
  return { labels, hidden, groups, views };
}

/**
 * The groups a view reads: the user groups (by id), then the default groups computed from the index (never stored).
 * A file belongs to the first group that matches it, user groups first, then the deepest default directory.
 */
export function effectiveGroups(store: Store): Group[] {
  return [...readOverlay(store).groups, ...defaultGroups(store.effectiveFiles())];
}

/** Sets a node's label; empty text removes it. */
export function setLabel(store: Store, label: Label): void {
  const l = LabelSchema.parse(label);
  store.tx(() => {
    if (l.text === "") store.db.prepare("DELETE FROM overlay.labels WHERE node_id = ?").run(l.nodeId);
    else
      store.db
        .prepare(
          "INSERT INTO overlay.labels(node_id, text) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET text = excluded.text",
        )
        .run(l.nodeId, l.text);
    syncAnchors(store, readOverlay(store));
  });
}

/** Replaces the global hidden list. */
export function setHidden(store: Store, selectors: Selector[]): void {
  const list = HiddenSchema.parse(selectors);
  store.tx(() => {
    store.db.prepare("DELETE FROM overlay.hidden").run();
    const ins = store.db.prepare("INSERT INTO overlay.hidden(position, selector) VALUES (?, ?)");
    list.forEach((s, i) => {
      ins.run(i, JSON.stringify(s));
    });
    syncAnchors(store, readOverlay(store));
  });
}

export function saveGroup(store: Store, group: Group): void {
  const g = GroupSchema.parse(group);
  store.tx(() => {
    store.db
      .prepare(
        "INSERT INTO overlay.groups(id, name, selectors) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, selectors = excluded.selectors",
      )
      .run(g.id, g.name, JSON.stringify(g.selectors));
    if (g.mayUse === null) store.db.prepare("DELETE FROM overlay.group_rules WHERE group_id = ?").run(g.id);
    else
      store.db
        .prepare(
          "INSERT INTO overlay.group_rules(group_id, may_use) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET may_use = excluded.may_use",
        )
        .run(g.id, JSON.stringify(g.mayUse));
    syncAnchors(store, readOverlay(store));
  });
}

/** Deletes a group, its rule, and its id from other groups' `mayUse` and from saved views' `groups`. False when absent. */
export function deleteGroup(store: Store, id: string): boolean {
  return store.tx(() => {
    const gone = store.db.prepare("DELETE FROM overlay.groups WHERE id = ?").run(id).changes > 0;
    store.db.prepare("DELETE FROM overlay.group_rules WHERE group_id = ?").run(id);
    const rules = store.db.prepare("SELECT group_id, may_use FROM overlay.group_rules").all() as {
      group_id: string;
      may_use: string;
    }[];
    for (const r of rules) {
      const list = JSON.parse(r.may_use) as string[];
      if (!list.includes(id)) continue;
      store.db
        .prepare("UPDATE overlay.group_rules SET may_use = ? WHERE group_id = ?")
        .run(JSON.stringify(list.filter((x) => x !== id)), r.group_id);
    }
    const views = store.db.prepare("SELECT id, spec FROM overlay.views").all() as {
      id: string;
      spec: string;
    }[];
    for (const v of views) {
      const spec = FilterSpecSchema.parse(JSON.parse(v.spec));
      if (!spec.groups.includes(id)) continue;
      const next = FilterSpecSchema.parse({ ...spec, groups: spec.groups.filter((x) => x !== id) });
      store.db.prepare("UPDATE overlay.views SET spec = ? WHERE id = ?").run(JSON.stringify(next), v.id);
    }
    syncAnchors(store, readOverlay(store));
    return gone;
  });
}

export function saveView(store: Store, view: SavedView): void {
  const v = SavedViewSchema.parse(view);
  store.tx(() => {
    store.db
      .prepare(
        "INSERT INTO overlay.views(id, name, spec) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec = excluded.spec",
      )
      .run(v.id, v.name, JSON.stringify(v.spec));
    syncAnchors(store, readOverlay(store));
  });
}

/** False when no such view exists. */
export function deleteView(store: Store, id: string): boolean {
  return store.tx(() => {
    const gone = store.db.prepare("DELETE FROM overlay.views WHERE id = ?").run(id).changes > 0;
    syncAnchors(store, readOverlay(store));
    return gone;
  });
}

/** Clears labels, hidden, groups, rules, saved views and anchors. Dismissals and layouts stay. */
export function resetOverlay(store: Store): void {
  store.tx(() => {
    for (const t of ["labels", "hidden", "groups", "group_rules", "views", "anchors", "anchor_renames"]) {
      store.db.prepare(`DELETE FROM overlay.${t}`).run();
    }
  });
}
