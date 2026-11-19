import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_HOME_MARKER = ".loom-fixture";
export function isFixtureScopedHome(home: string): boolean {
  if (!home) return false;
  if (existsSync(join(home, FIXTURE_HOME_MARKER))) return true;
  const underTemp = [tmpdir(), "/tmp", "/private/tmp", "/var/folders"].some(
    root => home.startsWith(root.endsWith("/") ? root : `${root}/`),
  );
  return underTemp && /(^|\/)loom-qa[^/]*/.test(home);
}
