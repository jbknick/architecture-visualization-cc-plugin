import { EyeIcon, PencilEdit01Icon, Tick02Icon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { api, type Group } from "../api.ts";
import { uniqueId, withHidden, withMember } from "../curation.ts";
import { useStore } from "../store.tsx";
import { NameDialog } from "./NameDialog.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { NativeSelect } from "./ui/native-select.tsx";

const NEW_GROUP = "\u0000new-group";

/**
 * Rename, Hide and Add to group for the node open in the inspector. Each is one overlay write (spec section 11);
 * the store then loads the overlay and the view again.
 */
export function CurationActions({ id }: { id: string }) {
  const { state, writeOverlay } = useStore();
  const overlay = state.overlay;
  const [renaming, setRenaming] = useState(false);
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!overlay) return null;

  const label = overlay.labels.find((l) => l.nodeId === id)?.text ?? null;
  const run = async (write: () => Promise<unknown>) => {
    setError(null);
    try {
      await writeOverlay(write);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const saveLabel = async () => {
    await run(() => api.putLabel(id, text.trim()));
    setRenaming(false);
  };
  const hidden = overlay.hidden.some((s) => s.type === "ids" && s.ids.includes(id));
  const addTo = (group: Group) => run(() => api.putGroup(withMember(group, id)));
  const memberOf = overlay.groups.filter((g) =>
    g.selectors.some((s) => s.type === "ids" && s.ids.includes(id)),
  );

  return (
    <section aria-label="Curate this node" className="curate">
      <div className="curate-row">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={renaming}
          onClick={() => {
            setText(label ?? "");
            setRenaming(!renaming);
          }}
        >
          <HugeiconsIcon icon={PencilEdit01Icon} size={14} aria-hidden="true" />
          Rename
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={hidden}
          title={
            hidden ? "Already hidden: use Show again in the Curation section" : "Take this out of every view"
          }
          onClick={() => void run(() => api.putHidden(withHidden(overlay.hidden, id)))}
        >
          <HugeiconsIcon icon={ViewOffIcon} size={14} aria-hidden="true" />
          Hide
        </Button>
        <NativeSelect
          size="sm"
          className="curate-group"
          value=""
          aria-label="Group"
          onChange={(e) => {
            const value = e.target.value;
            if (value === NEW_GROUP) setCreating(true);
            else {
              const group = overlay.groups.find((g) => g.id === value);
              if (group) void addTo(group);
            }
          }}
        >
          <option value="">Add to group…</option>
          {overlay.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value={NEW_GROUP}>New group…</option>
        </NativeSelect>
      </div>
      {renaming && (
        <form
          className="curate-row"
          onSubmit={(e) => {
            e.preventDefault();
            void saveLabel();
          }}
        >
          <Input
            aria-label="Label"
            value={text}
            maxLength={80}
            autoFocus
            autoComplete="off"
            placeholder="Empty removes the label"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(false);
              }
            }}
          />
          <Button type="submit" variant="outline" size="icon-sm" aria-label="Save label">
            <HugeiconsIcon icon={Tick02Icon} size={14} aria-hidden="true" />
          </Button>
        </form>
      )}
      {memberOf.length > 0 && (
        <p className="muted curate-in">
          <HugeiconsIcon icon={EyeIcon} size={14} aria-hidden="true" /> In{" "}
          {memberOf.map((g) => g.name).join(", ")}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <NameDialog
        open={creating}
        title="New group"
        description="The group starts with this node. Add more from their inspectors."
        confirm="Create"
        onClose={() => setCreating(false)}
        onSubmit={(name) =>
          writeOverlay(() => {
            const groupId = uniqueId(
              name,
              overlay.groups.map((g) => g.id),
            );
            if (groupId === null) throw new Error("A group name needs at least one letter or digit.");
            return api.putGroup({
              id: groupId,
              name,
              selectors: [{ type: "ids", ids: [id] }],
              mayUse: null,
            });
          })
        }
      />
    </section>
  );
}
