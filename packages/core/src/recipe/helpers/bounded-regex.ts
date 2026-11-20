import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";

/**
 * Regular expressions a recipe supplies (text rules, `receiverDecl`) are untrusted input, and the JavaScript engine
 * backtracks: `(a+)+$` on a long line can run for hours. They therefore never run on the calling thread. Each runs
 * in a worker thread that the caller waits for, synchronously, for a fixed budget; when the budget is spent the
 * worker is terminated (V8 interrupts a running regex) and the pattern is reported as timed out. The wait is
 * `Atomics.wait` on a shared flag, so callers stay synchronous and the calling thread is blocked for at most the
 * budget. This is a hard bound on time, not a check that a pattern "looks safe".
 */

/** The longest one pattern may run on one text. */
export const REGEX_JOB_BUDGET_MS = 100;
/** The most time all patterns of one run may use together, including a job that timed out. */
export const REGEX_RUN_BUDGET_MS = 400;
/** The longest the worker may take to start; not counted in the run budget. */
const STARTUP_MS = 500;
const MAX_MATCHES = 10_000;

export interface RegexMatch {
  index: number;
  /** Group 0 is the whole match; an unmatched group is an empty string. */
  groups: string[];
}

export type RegexResult =
  | { ok: true; matches: RegexMatch[] }
  | { ok: false; reason: "timeout" | "invalid" | "unavailable"; error?: string };

// Plain CommonJS, run with `eval: true`, so nothing has to be shipped as a separate file next to the bundle.
const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const flag = new Int32Array(workerData.sab);
const port = workerData.port;
const rows = (m) => ({ index: m.index || 0, groups: Array.from(m, (g) => (g === undefined ? "" : g)) });
port.on("message", (job) => {
  let res;
  try {
    const rx = new RegExp(job.source, job.flags);
    const out = [];
    if (job.first) {
      const m = rx.exec(job.text);
      if (m) out.push(rows(m));
    } else {
      for (const m of job.text.matchAll(rx)) {
        out.push(rows(m));
        if (out.length >= job.max) break;
      }
    }
    res = { ok: true, matches: out };
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  port.postMessage(res);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
`;

export class RegexRunner {
  private worker: Worker | null = null;
  private flag: Int32Array | null = null;
  private port: MessagePort | null = null;
  private spentMs = 0;

  constructor(
    readonly jobBudgetMs: number = REGEX_JOB_BUDGET_MS,
    readonly runBudgetMs: number = REGEX_RUN_BUDGET_MS,
  ) {}

  private start(): boolean {
    if (this.worker) return true;
    try {
      const sab = new SharedArrayBuffer(4);
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { sab, port: port2 },
        transferList: [port2],
      });
      worker.unref();
      worker.on("error", () => {});
      const flag = new Int32Array(sab);
      // Wait until the worker says it is ready (flag 1).
      Atomics.wait(flag, 0, 0, STARTUP_MS);
      if (Atomics.load(flag, 0) !== 1) {
        void worker.terminate();
        port1.close();
        return false;
      }
      this.worker = worker;
      this.flag = flag;
      this.port = port1;
      return true;
    } catch {
      return false;
    }
  }

  /** Runs `new RegExp(source, flags)` over `text`: every match, or with `first` only the first. */
  run(source: string, flags: string, text: string, first = false): RegexResult {
    const left = this.runBudgetMs - this.spentMs;
    if (left <= 0) return { ok: false, reason: "timeout" };
    if (!this.start() || !this.flag || !this.port) return { ok: false, reason: "unavailable" };
    const budget = Math.min(this.jobBudgetMs, left);
    const f = flags.replace(/[gy]/g, "");
    const job = { source, flags: first ? f : `${f}g`, text, first, max: MAX_MATCHES };
    Atomics.store(this.flag, 0, 0);
    this.port.postMessage(job);
    const t0 = performance.now();
    Atomics.wait(this.flag, 0, 0, budget);
    const done = Atomics.load(this.flag, 0) === 1;
    this.spentMs += performance.now() - t0;
    if (!done) {
      this.stopWorker();
      return { ok: false, reason: "timeout" };
    }
    const msg = receiveMessageOnPort(this.port)?.message as
      | { ok: true; matches: RegexMatch[] }
      | { ok: false; error: string }
      | undefined;
    if (!msg) return { ok: false, reason: "unavailable" };
    return msg.ok ? msg : { ok: false, reason: "invalid", error: msg.error };
  }

  private stopWorker(): void {
    void this.worker?.terminate();
    this.port?.close();
    this.worker = null;
    this.flag = null;
    this.port = null;
  }

  /** Terminates the worker; call when the run is over. */
  close(): void {
    this.stopWorker();
  }
}
