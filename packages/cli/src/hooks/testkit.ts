import { realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

/**
 * Hook tests write hooks, git config and a shim. Call this before any install code runs: it throws
 * unless HOME is a directory under the OS temp dir, so the real `~/.gantry` can never be touched.
 */
export function assertTempHome(home: string | undefined = process.env.HOME): string {
  if (!home) throw new Error("HOME is not set");
  const tmp = realpathSync(tmpdir());
  const resolved = path.resolve(home);
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // not created yet: judge the lexical path
  }
  const under = (p: string): boolean => p === tmp || p.startsWith(tmp + path.sep);
  if (!under(real) && !under(resolved)) throw new Error(`refusing to run: HOME ${home} is not under ${tmp}`);
  // userInfo() reads the passwd entry, not $HOME, so it still names the real home after HOME is overridden.
  if (real === realpathSync(userInfo().homedir))
    throw new Error("refusing to run: HOME is the real home directory");
  return resolved;
}
