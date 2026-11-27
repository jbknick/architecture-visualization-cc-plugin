import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { normalizeServer } from "../config/team.js";

const EntrySchema = z.object({ token: z.string().min(1), user: z.string(), expires_at: z.string() });
const FileSchema = z.object({ servers: z.record(z.string(), EntrySchema) });

export type Credential = z.infer<typeof EntrySchema>;

/**
 * The credentials file: `GANTRY_CREDENTIALS_FILE` when set (tests), else `~/.gantry/credentials.json`. It holds one
 * entry per server URL and is written with mode 600 in a directory of mode 700 (spec section 4).
 */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GANTRY_CREDENTIALS_FILE;
  if (override !== undefined && override !== "") return override;
  return path.join(env.HOME || os.homedir(), ".gantry", "credentials.json");
}

function readAll(file: string): Record<string, Credential> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.servers : {};
  } catch {
    return {}; // an unreadable file is the same as no sign-in; the next write replaces it
  }
}

function writeAll(file: string, servers: Record<string, Credential>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ servers }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The stored sign-in for a server, or undefined. */
export function readCredential(server: string, env: NodeJS.ProcessEnv = process.env): Credential | undefined {
  return readAll(credentialsPath(env))[normalizeServer(server)];
}

/** Stores (or replaces) the sign-in for a server. Other servers' entries stay. */
export function writeCredential(
  server: string,
  credential: Credential,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = credentialsPath(env);
  writeAll(file, { ...readAll(file), [normalizeServer(server)]: credential });
}

/** Removes a server's entry. Returns false when there was none (the file is then left alone). */
export function removeCredential(server: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = credentialsPath(env);
  const servers = readAll(file);
  const key = normalizeServer(server);
  if (!(key in servers)) return false;
  delete servers[key];
  writeAll(file, servers);
  return true;
}
