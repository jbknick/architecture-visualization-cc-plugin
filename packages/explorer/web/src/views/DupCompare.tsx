import { useMemo } from "react";
import type { DupMember } from "../api.ts";
import { type Token, tokenizeLines } from "../highlight.ts";
import { useSource } from "../hooks.ts";
import { alignLines } from "./dupModel.ts";

/** Longest function shown in full; longer ones are cut with a note. */
export const COMPARE_MAX_LINES = 120;

interface Props {
  keep: DupMember;
  other: DupMember;
}

function clampEnd(m: DupMember): number {
  return Math.min(m.endLine, m.line + COMPARE_MAX_LINES - 1);
}

function Code({ tokens }: { tokens: Token[] | undefined }) {
  // Tokens are plain strings rendered as React text nodes: source text is never parsed as HTML.
  return (
    <>
      {(tokens ?? []).map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reordered
        <span key={i} className={`tok-${t.type}`}>
          {t.text}
        </span>
      ))}
    </>
  );
}

/**
 * The keep candidate on the left, the other copy on the right, lines aligned so a changed line sits opposite
 * its counterpart. Lines that differ are tinted; indentation does not count as a difference.
 */
export function DupCompare({ keep, other }: Props) {
  const left = useSource(keep.path, keep.line, clampEnd(keep));
  const right = useSource(other.path, other.line, clampEnd(other));
  const leftLines = left.data?.lines;
  const rightLines = right.data?.lines;
  const rows = useMemo(
    () => (leftLines && rightLines ? alignLines(leftLines, rightLines) : []),
    [leftLines, rightLines],
  );
  const leftTokens = useMemo(() => (leftLines ? tokenizeLines(leftLines) : []), [leftLines]);
  const rightTokens = useMemo(() => (rightLines ? tokenizeLines(rightLines) : []), [rightLines]);
  const differing = rows.filter((r) => r.differs).length;
  const cut =
    keep.endLine - keep.line + 1 > COMPARE_MAX_LINES || other.endLine - other.line + 1 > COMPARE_MAX_LINES;

  const failed = (left.error && !left.data) || (right.error && !right.data);
  return (
    <section className="dup-compare" aria-label={`Compare ${other.name} with ${keep.name}`}>
      <div className="dup-compare-head">
        <h3>
          Side by side
          {leftLines && rightLines && (
            <span className="dup-compare-count">
              {differing === 0
                ? "no differing lines"
                : `${differing} differing ${differing === 1 ? "line" : "lines"}`}
            </span>
          )}
        </h3>
      </div>
      {failed ? (
        <p className="muted">Source is not available for one of these files.</p>
      ) : !leftLines || !rightLines ? (
        <p className="muted">Loading source…</p>
      ) : (
        <div className="dup-diff">
          <div className="dup-diff-row dup-diff-title">
            <div className="dup-cell dup-cell-title">
              <span className="dup-keep-tag">Keep this one</span> {keep.name}
              <code>
                {keep.path}:{keep.line}
              </code>
            </div>
            <div className="dup-cell dup-cell-title">
              {other.name}
              <code>
                {other.path}:{other.line}
              </code>
            </div>
          </div>
          <div className="dup-diff-body">
            {rows.map((r, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reordered
                key={i}
                className={`dup-diff-row ${r.differs ? "is-diff" : ""}`}
                data-diff={r.differs ? "true" : "false"}
              >
                <div className={`dup-cell ${r.left === null ? "is-empty" : ""}`}>
                  {r.left !== null && (
                    <>
                      <span className="dup-no" aria-hidden="true">
                        {keep.line + r.left}
                      </span>
                      <code className="dup-code">
                        <Code tokens={leftTokens[r.left]} />
                      </code>
                    </>
                  )}
                </div>
                <div className={`dup-cell ${r.right === null ? "is-empty" : ""}`}>
                  {r.right !== null && (
                    <>
                      <span className="dup-no" aria-hidden="true">
                        {other.line + r.right}
                      </span>
                      <code className="dup-code">
                        <Code tokens={rightTokens[r.right]} />
                      </code>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          {cut && (
            <p className="muted dup-cut">Long function: the first {COMPARE_MAX_LINES} lines are shown.</p>
          )}
        </div>
      )}
    </section>
  );
}
