import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether this host lets an ordinary process create a symbolic link.
 *
 * A non-elevated Windows process is denied `symlink()` without Developer Mode or the
 * create-symlink privilege (`EPERM`); the GitHub Windows runners have it. Fixtures that need a
 * link skip with this reason instead of treating the refusal as a failed assertion.
 *
 * Probed once, lazily: a single temp directory, removed immediately.
 */
export const symlinkRefusal = (() => {
  const dir = mkdtempSync(join(tmpdir(), "symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync("target", join(dir, "link"));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return "this host denies symlink() to an unprivileged process";
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();