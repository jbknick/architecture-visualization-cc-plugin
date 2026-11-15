import type { ApiContext, ViewModule, ViewParams } from "../types.js";
import { buildProjectMap } from "./projectMap.js";
import { type ReviewResult, reviewFor, reviewMapOf, reviewRings, wantsReview } from "./review.js";

/**
 * View 6. Review / blast radius (#44, on the map since #167). Params `range` (`<base>...<head>`) or `pr` (a pull
 * request number, resolved with `gh`); without either the view is empty and `review` is null.
 *
 * The nodes and edges are the project map's for the same level and filters (so every node sits where it sits on the
 * plain map), and `review` carries the diff, impact and risk plus `review.layer`: marks by node id and the lines from
 * direct consumers to the changed symbols and from potential consumers to the node one step nearer, lifted to the
 * map's level. `map=3d` draws the same review on the
 * 3D map (settlements, one building per file), so the nodes are the project map's Files level. Hint `review`: the web
 * renders it through the 2D map canvas or the 3D one.
 */
// `mode=rings`: the changed symbols in the centre and their callers on rings by hop, grouped by file (`reviewRings`).
export async function buildReview(ctx: ApiContext, params: ViewParams): Promise<ReviewResult> {
  if (!wantsReview(params)) return { nodes: [], edges: [], layoutHint: "review", review: null };
  if (params.options?.mode === "rings") {
    const r = await reviewRings(ctx, params);
    return r
      ? { nodes: r.nodes, edges: r.edges, layoutHint: "review", review: r.review }
      : { nodes: [], edges: [], layoutHint: "review", review: null };
  }
  // `focus` is the selected change here (a deep link's), not a subtree: the review always shows the whole map.
  const { focus: _focus, ...rest } = params;
  const mapParams: ViewParams = reviewMapOf(params) === "3d" ? { ...rest, level: "files" } : rest;
  const { result, place } = buildProjectMap(ctx.store, mapParams);
  const review = await reviewFor(ctx, mapParams, place);
  return { nodes: result.nodes, edges: result.edges, layoutHint: "review", review };
}

export const reviewView: ViewModule = {
  id: "review",
  title: "Review",
  enabled: true,
  build: (ctx, params) => buildReview(ctx, params),
};
