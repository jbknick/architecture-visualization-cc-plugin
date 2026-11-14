import { type RankedFile, whereLine } from "../rankedFiles/rank.ts";

export interface LargestFilesProps {
  files: RankedFile[];
  /** Workspace the ranking is restricted to (id), or null for all. */
  scope: string | null;
  scopes: { id: string; label: string }[];
  onScope: (id: string | null) => void;
  /** Workspace dot colour for a workspace id. */
  colorOf: (workspaceId: string) => string;
  /** The row was clicked: select the file (inspector). */
  onSelect: (id: string) => void;
  /** The row was clicked: bring the file into view on the canvas. */
  onFocus: (id: string) => void;
  /** The pointer or keyboard focus entered (id) or left (null) a row: the canvas highlights the file. */
  onHover: (id: string | null) => void;
  selectedId?: string | null;
}

/**
 * The "Largest files" section of the left panel, shared by the 2D and the 3D map: the top files by function count,
 * numbered like the markers on the canvas, with a menu to restrict the ranking to one workspace.
 */
export function LargestFiles({
  files,
  scope,
  scopes,
  onScope,
  colorOf,
  onSelect,
  onFocus,
  onHover,
  selectedId,
}: LargestFilesProps) {
  return (
    <section className="largest-files" aria-label="Largest files" data-testid="largest-files">
      <h3 className="panel-title">Largest files</h3>
      <label className="largest-scope">
        <span>Top files in:</span>
        <select
          aria-label="Top files in"
          value={scope ?? ""}
          onChange={(e) => onScope(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">all</option>
          {scopes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {files.length === 0 ? (
        <p className="muted">No files to rank.</p>
      ) : (
        <ol className="largest-list">
          {files.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className={`largest-row ${selectedId === f.id ? "is-active" : ""}`}
                data-file={f.id}
                data-rank={f.rank}
                title={f.path}
                onClick={() => {
                  onSelect(f.id);
                  onFocus(f.id);
                }}
                onMouseEnter={() => onHover(f.id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(f.id)}
                onBlur={() => onHover(null)}
              >
                <span
                  className="largest-num"
                  style={{ borderColor: colorOf(f.workspaceId) }}
                  aria-hidden="true"
                >
                  {f.rank}
                </span>
                <span className="largest-name">{f.name}</span>
                <span className="largest-count">{f.functions.toLocaleString("en-US")} fn</span>
                <span className="largest-where">
                  <span
                    className="kind-dot"
                    style={{ background: colorOf(f.workspaceId) }}
                    aria-hidden="true"
                  />
                  {whereLine(f)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
