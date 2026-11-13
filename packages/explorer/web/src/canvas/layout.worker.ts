// Runs layouts off the main thread. Messages: LayoutInput in, WorkerReply out.
import { computeLayout } from "./layout.ts";
import type { LayoutInput, LayoutResult } from "./types.ts";

export type WorkerReply = { ok: true; result: LayoutResult } | { ok: false; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutInput>) => void) | null;
  postMessage(message: WorkerReply): void;
};

scope.onmessage = (event) => {
  computeLayout(event.data).then(
    (result) => scope.postMessage({ ok: true, result }),
    (err: unknown) =>
      scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
};
