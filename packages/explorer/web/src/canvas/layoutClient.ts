import type { WorkerReply } from "./layout.worker.ts";
import type { LayoutInput, LayoutResult } from "./types.ts";

export interface LayoutJob {
  promise: Promise<LayoutResult>;
  cancel(): void;
}

/** Starts a layout in a Web Worker. Falls back to the main thread where Workers do not exist (jsdom tests). */
export function runLayout(input: LayoutInput): LayoutJob {
  if (typeof Worker === "undefined") {
    let cancelled = false;
    const promise = import("./layout.ts").then(async ({ computeLayout }) => {
      const result = await computeLayout(input);
      if (cancelled) throw new Error("cancelled");
      return result;
    });
    return {
      promise,
      cancel() {
        cancelled = true;
      },
    };
  }
  const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  const promise = new Promise<LayoutResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Layout worker failed"));
    };
    worker.postMessage(input);
  });
  return {
    promise,
    cancel() {
      worker.terminate();
    },
  };
}
