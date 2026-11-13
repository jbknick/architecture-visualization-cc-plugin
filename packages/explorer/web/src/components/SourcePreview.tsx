import { useMemo } from "react";
import { tokenizeLines } from "../highlight.ts";
import { useSource } from "../hooks.ts";

interface Props {
  path: string;
  start: number;
  end: number;
}

export function SourcePreview({ path, start, end }: Props) {
  const { data, loading, error } = useSource(path, start, end);
  const lines = useMemo(() => (data ? tokenizeLines(data.lines) : []), [data]);

  if (error && !data) return <p className="muted">Source is not available for this file.</p>;
  if (!data) return <p className="muted">{loading ? "Loading source…" : ""}</p>;

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex lint/a11y/useAriaPropsSupportedByRole: scrollable code needs keyboard focus and a name
    <pre className="source" tabIndex={0} aria-label={`Source of ${path}`}>
      <code>
        {lines.map((tokens, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reordered
          <span className="src-line" key={i}>
            <span className="src-no" aria-hidden="true">
              {data.start + i}
            </span>
            {tokens.map((t, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
              <span key={j} className={`tok-${t.type}`}>
                {t.text}
              </span>
            ))}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}
