import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The names this repository must not ship under.
 *
 * Each is written as the pieces it is made of so this file itself never contains the literal a
 * scan would find. The product is Loom; anything that ships under an older name is a regression
 * of the rename.
 */
const legacyNames = new RegExp([
  ["multi", "agent"].join("[-_ ]"),
  ["cpoot", "gxl"].join(""),
  ["open", "rig"].join(""),
  ["rig", "ged"].join(""),
].join("|"), "i");
// History: plans, validation records, amendments, task notes, and the as-built/release record of
// what the product was at the time. These describe past states and are never rewritten.
const historicalRoots = [
  "docs/plans/", "docs/validation/", "docs/amendments/", "docs/tasks/",
  "engine/docs/as-built/", "engine/docs/releases/",
];
// Explicit third-party skill files whose source provenance is preserved verbatim.
const vendoredSkillAllowlist = new Set([
  "engine/packages/daemon/specs/agents/shared/skills/process/agent-browser/SKILL.md",
  ["engine", "packages", "daemon", "specs", "agents", "shared", "skills", "process", "agent-browser", "OPEN" + "RIG.md"].join("/"),
  "engine/packages/daemon/specs/agents/shared/skills/process/dogfood/SKILL.md",
  "engine/packages/daemon/specs/agents/shared/skills/process/frontend-design/SKILL.md",
  "engine/packages/daemon/specs/agents/shared/skills/process/systematic-debugging/SKILL.md",
  "engine/packages/daemon/specs/agents/shared/skills/process/test-driven-development/SKILL.md",
  "engine/packages/daemon/specs/agents/shared/skills/process/verification-before-completion/SKILL.md",
  "engine/skills/_canonical/process/agent-browser/SKILL.md",
  ["engine", "skills", "_canonical", "process", "agent-browser", "OPEN" + "RIG.md"].join("/"),
  "engine/skills/_canonical/process/dogfood/SKILL.md",
  "engine/skills/_canonical/process/frontend-design/SKILL.md",
  "engine/skills/_canonical/process/systematic-debugging/SKILL.md",
  "engine/skills/_canonical/process/test-driven-development/SKILL.md",
  "engine/skills/_canonical/process/verification-before-completion/SKILL.md",
  "engine/scripts/skill-edge-digests.generated.json",
]);
// Files that must name an old identifier because their contract is to read it: the one-time data
// migration and the browser preference migration.
const migrationAllowlist = new Set([
  "engine/packages/daemon/src/migrate-data-root.ts",
  "engine/packages/daemon/test/migrate-data-root.test.ts",
  "engine/packages/daemon/test/data-paths.test.ts",
  "engine/packages/ui/src/team/preferences.ts",
  "engine/packages/ui/src/team/__tests__/preferences.test.ts",
  "engine/packages/ui/index.html",
  "desktop/src/data-root.js",
  // The policy files name identifiers a scrub must catch; renaming them would stop the scanner
  // from finding the strings it exists to find.
  "engine/scripts/internal-tokens.generated.json",
  "engine/scripts/product-public-skills.generated.json",
  // This test builds a home selector from its pieces, to prove it is not honoured.
  "engine/scripts/test-instance-isolation.test.mjs",
  // A browser-access test names a host header it must refuse.
  "engine/packages/daemon/test/browser-boundary.test.ts",
  "companions/loom/scripts/configure-local.py",
]);

export function scanBrand(root) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  // Include new source files during an uncommitted rename as well as indexed files.
  const added = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "engine", "desktop", "scripts", ".github"],
    { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = [];
  for (const file of new Set([...tracked, ...added])) {
    if (historicalRoots.some(prefix => file.startsWith(prefix))
      || /changelog/i.test(basename(file)) || /^(LICENSE|NOTICE)(\..*)?$/i.test(basename(file))
      || vendoredSkillAllowlist.has(file) || migrationAllowlist.has(file)) continue;
    // A compiled or vendored archive is not source; it is regenerated from source that is scanned.
    if (/\.(base64|snap)$/.test(file) || file.includes("/node_modules/")) continue;
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (legacyNames.test(line)) findings.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const findings = scanBrand(root);
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else console.log("Source brand scan passed.");
}