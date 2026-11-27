// Release tarballs (issue #281). `packRelease` writes dist/gantry-<version>.tgz and its .sha256 file, byte-identical on
// every run for the same commit: entries sorted by path, fixed modes, uid/gid 0, mtime = the tagged commit's committer
// time, gzip header without mtime or file name. ustar and gzip are written with node:zlib only; no network, no npm.
// `packProtocol` writes dist/gantry-protocol-<version>.tgz and its .sha256 file beside it: the `@gantry/protocol` package
// as `npm pack` lays it out (top directory `package/`), by the same writer, for any consumer that pins the protocol by
// URL and checksum. `pnpm release:pack` runs both for the current version; scripts/version.ts calls them from `release()`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/** Entries of plugin/ that ship, placed directly under the top directory (gantry/bin/gantry, gantry/dist/cli.js). */
const PLUGIN_ENTRIES = ["bin", "dist", "agents", "skills", "hooks", ".claude-plugin", ".mcp.json"];
const TOP = "gantry";
const EXECUTABLE = `${TOP}/bin/gantry`;
const SKIPPED = new Set(["node_modules", ".DS_Store"]);

export interface PackResult {
  tarball: string;
  sha256File: string;
  sha256: string;
}

interface Entry {
  path: string; // archive path; a directory ends in "/"
  data: Buffer | null; // null for a directory
  mode: number;
}

function walk(dir: string, rel: string, out: Entry[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name)) continue;
    const abs = join(dir, name);
    const path = `${rel}/${name}`;
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      out.push({ path: `${path}/`, data: null, mode: 0o755 });
      walk(abs, path, out);
    } else if (st.isFile()) {
      out.push({ path, data: readFileSync(abs), mode: path === EXECUTABLE ? 0o755 : 0o644 });
    } else {
      throw new Error(`${abs}: only files and directories can be packed`);
    }
  }
}

/** Every entry of the archive, sorted by path (byte order). */
function collect(root: string, version: string): Entry[] {
  const plugin = join(root, "plugin");
  if (!existsSync(join(plugin, "dist"))) throw new Error("plugin/dist is missing: run pnpm build");
  const deps = join(root, "scripts", "release-deps");
  const manifest = JSON.parse(readFileSync(join(deps, "package.json"), "utf8")) as Record<string, unknown>;
  const { name, ...rest } = manifest;
  const packageJson = `${JSON.stringify({ name, version, ...rest }, null, 2)}\n`;

  const entries: Entry[] = [{ path: `${TOP}/`, data: null, mode: 0o755 }];
  for (const name of PLUGIN_ENTRIES) {
    const abs = join(plugin, name);
    if (!existsSync(abs)) continue;
    const path = `${TOP}/${name}`;
    if (lstatSync(abs).isDirectory()) {
      entries.push({ path: `${path}/`, data: null, mode: 0o755 });
      walk(abs, path, entries);
    } else {
      entries.push({ path, data: readFileSync(abs), mode: 0o644 });
    }
  }
  entries.push({ path: `${TOP}/LICENSE`, data: readFileSync(join(root, "LICENSE")), mode: 0o644 });
  entries.push({ path: `${TOP}/package.json`, data: Buffer.from(packageJson), mode: 0o644 });
  entries.push({
    path: `${TOP}/package-lock.json`,
    data: readFileSync(join(deps, "package-lock.json")),
    mode: 0o644,
  });
  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(entry: Entry, mtime: number): Buffer {
  const isDir = entry.data === null;
  let name = entry.path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    // ustar splits a long path at a "/" into prefix (155) and name (100)
    const trimmed = isDir ? name.slice(0, -1) : name;
    const at = trimmed.lastIndexOf("/", trimmed.length - 1);
    prefix = trimmed.slice(0, at);
    name = trimmed.slice(at + 1) + (isDir ? "/" : "");
    if (at < 1 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100)
      throw new Error(`${entry.path}: path too long for a ustar archive`);
  }
  const block = Buffer.alloc(512);
  block.write(name, 0, "utf8");
  block.write(octal(entry.mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(entry.data?.length ?? 0, 12), 124, "ascii");
  block.write(octal(mtime, 12), 136, "ascii");
  block.write("        ", 148, "ascii"); // checksum counts these eight bytes as spaces
  block.write(isDir ? "5" : "0", 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(prefix, 345, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function ustar(entries: Entry[], mtime: number): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry, mtime));
    if (entry.data && entry.data.length > 0) {
      parts.push(entry.data);
      const pad = (512 - (entry.data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024)); // end of archive
  return Buffer.concat(parts);
}

/** Committer time (seconds) of the tag v<version> when it exists, else of HEAD. */
function commitTime(root: string, version: string): number {
  const git = (ref: string) =>
    execFileSync("git", ["log", "-1", "--format=%ct", ref], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  let out: string;
  try {
    out = git(`v${version}^{commit}`);
  } catch {
    out = git("HEAD");
  }
  const time = Number(out);
  if (!Number.isInteger(time) || time < 0) throw new Error(`cannot read the commit time (got "${out}")`);
  return time;
}

function finish(root: string, entries: Entry[], mtime: number, name: string): PackResult {
  const archive = gzipSync(ustar(entries, mtime), { level: 9 }); // node:zlib writes mtime 0 and no file name
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const outDir = join(root, "dist");
  mkdirSync(outDir, { recursive: true });
  const tarball = join(outDir, name);
  const sha256File = `${tarball}.sha256`;
  writeFileSync(tarball, archive);
  writeFileSync(sha256File, `${sha256}  ${name}\n`);
  return { tarball, sha256File, sha256 };
}

/** Build dist/gantry-<version>.tgz and dist/gantry-<version>.tgz.sha256 from `root`. Needs plugin/dist built. */
export function packRelease(root: string, version: string): PackResult {
  const entries = collect(root, version);
  return finish(root, entries, commitTime(root, version), `gantry-${version}.tgz`);
}

const PROTOCOL = "packages/protocol";
const PROTOCOL_TOP = "package";
/** Fields of packages/protocol/package.json that the tarball keeps, in this order (no scripts, no devDependencies). */
const PROTOCOL_FIELDS = ["name", "version", "type", "main", "types", "exports", "dependencies", "files"];

/** Every file under `dir` (relative paths with "/"), skipping SKIPPED names. */
function files(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel))) {
    if (SKIPPED.has(name)) continue;
    const path = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, path));
    if (st.isDirectory()) out.push(...files(dir, path));
    else if (st.isFile()) out.push(path);
    else throw new Error(`${join(dir, path)}: only files and directories can be packed`);
  }
  return out;
}

/** Files of packages/protocol/dist that ship: no test output, no source maps, no tsbuildinfo. */
const shipsFromDist = (file: string): boolean =>
  !/\.test\./.test(file) && !/\.map$|\.tsbuildinfo$/.test(file);

function protocolEntries(root: string, version: string): Entry[] {
  const pkgDir = join(root, PROTOCOL);
  const dist = join(pkgDir, "dist");
  if (!existsSync(dist)) throw new Error(`${PROTOCOL}/dist is missing: run pnpm build`);
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const field of PROTOCOL_FIELDS) if (field in manifest) kept[field] = manifest[field];
  kept.version = version;
  const entries: Entry[] = [
    { path: `${PROTOCOL_TOP}/LICENSE`, data: readFileSync(join(root, "LICENSE")), mode: 0o644 },
    {
      path: `${PROTOCOL_TOP}/package.json`,
      data: Buffer.from(`${JSON.stringify(kept, null, 2)}\n`),
      mode: 0o644,
    },
  ];
  for (const file of files(dist).filter(shipsFromDist))
    entries.push({ path: `${PROTOCOL_TOP}/dist/${file}`, data: readFileSync(join(dist, file)), mode: 0o644 });
  const examples = join(pkgDir, "examples");
  if (existsSync(examples))
    for (const file of files(examples))
      entries.push({
        path: `${PROTOCOL_TOP}/examples/${file}`,
        data: readFileSync(join(examples, file)),
        mode: 0o644,
      });
  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

/**
 * Build dist/gantry-protocol-<version>.tgz and its .sha256 file from the built packages/protocol: package.json (with
 * `version` set), LICENSE, the non-test files of dist/ and the example payloads, files only, mtime as for the CLI tarball.
 */
export function packProtocol(root: string, version: string): PackResult {
  const entries = protocolEntries(root, version);
  return finish(root, entries, commitTime(root, version), `gantry-protocol-${version}.tgz`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = process.cwd();
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string })
      .version;
    for (const { tarball, sha256File, sha256 } of [packRelease(root, version), packProtocol(root, version)])
      console.log(`${tarball}\n${sha256File}\nsha256 ${sha256}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
