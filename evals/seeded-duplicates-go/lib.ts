/**
 * Shared harness of the Go seeded duplicates (spec section 17): `seeded.test.ts` runs it without a model and `run.ts`
 * with the local embedding model. The base module is copied to a throwaway git repo and indexed; each case writes its
 * new code to `targetFile`, indexes the working layer, asks the duplicate engine about the new function and then clears
 * the working layer again. All code here is hand-written and public.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DupCandidate,
  findDuplicates,
  indexRepo,
  openStore,
  resolvePaths,
  type Store,
  type SymbolRecord,
  type Tier,
} from "../../packages/core/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const baseDir = join(here, "base");

export interface SeededGoCase {
  id: string;
  misleading: boolean;
  /** `<repo-relative path>#<symbol name>` of the function the new code duplicates. */
  existing: string;
  targetFile: string;
  /** Hand-written code for `targetFile`. */
  newCode?: string;
  /** Instead of `newCode`: copy `existing` under this name, into a new file of the target's package. */
  copyAs?: string;
  expected: { tiers: Tier[] };
}

export interface NegativeCase {
  id: string;
  kind: "unrelated" | "cross_language";
  targetFile: string;
  newCode: string;
  note?: string;
  /** cross_language only: the TypeScript function whose logic the Go code copies. */
  tsExisting?: string;
}

export const loadCases = (): SeededGoCase[] =>
  JSON.parse(readFileSync(join(here, "cases.json"), "utf8")) as SeededGoCase[];
export const loadNegatives = (): NegativeCase[] =>
  JSON.parse(readFileSync(join(here, "negatives.json"), "utf8")) as NegativeCase[];

export interface Found {
  /** Symbol id of the new function. */
  symbolId: string;
  candidates: DupCandidate[];
}

export class Harness {
  private constructor(
    readonly dir: string,
    readonly env: NodeJS.ProcessEnv,
    private readonly parent: string,
    private readonly data: string,
    readonly store: Store,
  ) {}

  /** Copies `base/` to a temp git repo, commits it and indexes the main layer. */
  static async create(): Promise<Harness> {
    const parent = mkdtempSync(join(tmpdir(), "gantry-seeded-go-"));
    const dir = join(parent, "seeded"); // the repo name (no remote) is this basename
    cpSync(baseDir, dir, { recursive: true });
    const data = mkdtempSync(join(tmpdir(), "gantry-seeded-go-data-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    };
    git("init", "-b", "main");
    git("config", "user.name", "Gantry Seeded");
    git("config", "user.email", "seeded@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", "-A", "-f");
    git("commit", "-m", "base");
    const env = { ...process.env, HOME: join(data, "home"), CLAUDE_PLUGIN_DATA: data };
    const paths = resolvePaths(dir, env);
    await indexRepo(paths, { layer: "main" });
    return new Harness(dir, env, parent, data, openStore(paths.dbPath));
  }

  close(): void {
    this.store.close();
    rmSync(this.parent, { recursive: true, force: true });
    rmSync(this.data, { recursive: true, force: true });
  }

  /** Symbol id of `<path>#<name>`. */
  id(existing: string): string {
    const [path, name] = existing.split("#") as [string, string];
    return `sym:${this.store.repo()}:${path}#${name}`;
  }

  /** The code a case writes: `newCode`, or the existing function copied under `copyAs`. */
  codeOf(c: SeededGoCase): string {
    if (c.newCode !== undefined) return c.newCode;
    if (c.copyAs === undefined) throw new Error(`${c.id}: needs newCode or copyAs`);
    const sym = this.store.getSymbol(this.id(c.existing)) as SymbolRecord;
    const [path] = c.existing.split("#") as [string, string];
    const text = readFileSync(join(this.dir, path), "utf8");
    const body = text
      .split("\n")
      .slice(sym.startLine - 1, sym.endLine)
      .join("\n")
      .replace(`func ${sym.name}(`, `func ${c.copyAs}(`);
    const imports = /^import\s+(\([\s\S]*?\n\)|"[^"\n]*")/m.exec(text)?.[0] ?? "";
    return `package ${basename(dirname(c.targetFile))}\n\n${imports}\n\n${body}\n`;
  }

  /** Writes `code` to `file`, indexes the working layer and returns the duplicate candidates of its function. */
  async place(file: string, code: string): Promise<Found> {
    mkdirSync(dirname(join(this.dir, file)), { recursive: true });
    writeFileSync(join(this.dir, file), code);
    const paths = resolvePaths(this.dir, this.env);
    await indexRepo(paths, { layer: "working", files: [file], store: this.store });
    return this.again(file);
  }

  /** The duplicate candidates of the one function in `file` (already placed), as the store holds it now. */
  async again(file: string): Promise<Found> {
    const mine = this.store
      .effectiveSymbols({ kind: ["function", "method"] })
      .filter((s) => s.fileId.endsWith(`:${file}`));
    const sym = mine[0];
    if (!sym || mine.length !== 1) throw new Error(`${file}: expected one function, found ${mine.length}`);
    const candidates = await findDuplicates(this.store, { symbol: sym }, { limit: 10 });
    return { symbolId: sym.id, candidates };
  }

  /** Embeds what has no vector yet (the main layer, and a draft in the working layer) with the built CLI. */
  embed(): void {
    const cli = join(here, "..", "..", "plugin", "dist", "cli.js");
    const r = spawnSync("node", [cli, "embed"], { cwd: this.dir, env: this.env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`gantry embed failed: ${r.stderr || r.stdout}`);
  }

  /** Removes the file and drops the working layer, so the next case starts from the base module alone. */
  clear(file: string): void {
    rmSync(join(this.dir, file), { force: true });
    this.store.clearWorking();
  }
}
