// OPR.0.6.1.6 — every SKILL.md the package ships must pass the runtime
// frontmatter contract (`---` block with name + description, non-empty body). scripts/build-package.sh copies
// packages/daemon/specs and packages/daemon/assets wholesale into the npm
// artifact, so those are the roots checked here. The package-time
// context-packs projection is generated from packages/daemon/specs/agents/
// shared/skills (generate-context-packs.mjs), so its source skills are
// covered by the specs root.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/** The frontmatter shape Claude Code and Codex both load: a YAML block with `name` + `description`, plus a body. */
function parseSkillFrontmatter(content: string): { ok: true } | { ok: false; reason: string } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { ok: false, reason: "no YAML frontmatter delimited by --- lines" };
  let parsed: unknown;
  try { parsed = parseYaml(match[1]!); } catch (err) { return { ok: false, reason: `frontmatter YAML parse error: ${err instanceof Error ? err.message : String(err)}` }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "frontmatter is not a YAML mapping" };
  const frontmatter = parsed as Record<string, unknown>;
  if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) return { ok: false, reason: "frontmatter missing required \`name\` field" };
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) return { ok: false, reason: "frontmatter missing required \`description\` field" };
  if (!match[2]?.trim()) return { ok: false, reason: "SKILL.md body is empty (the runtime would have nothing to load)" };
  return { ok: true };
}
const SHIPPED_ROOTS = ["specs", "assets"].map((r) => join(PACKAGE_ROOT, r));

function findSkillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSkillFiles(full));
    else if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
  }
  return out;
}

describe("shipped SKILL.md frontmatter", () => {
  const skillFiles = SHIPPED_ROOTS.filter((r) => existsSync(r)).flatMap(findSkillFiles);

  it("finds shipped skills under every shipped root", () => {
    // Compare in one separator spelling: the walker returns host-native paths.
    const posix = (p: string) => p.split(sep).join("/");
    for (const root of SHIPPED_ROOTS) {
      expect(skillFiles.some((f) => posix(f).startsWith(posix(root) + "/")), `no skill.md under ${root}`).toBe(true);
    }
  });

  it("every shipped SKILL.md passes parseSkillFrontmatter", () => {
    const failures = skillFiles.flatMap((file) => {
      const result = parseSkillFrontmatter(readFileSync(file, "utf8"));
      return result.ok ? [] : [`${relative(PACKAGE_ROOT, file)}: ${result.reason}`];
    });
    expect(failures).toEqual([]);
  });

  it("rejects a shipped skill whose frontmatter is removed", () => {
    const vault = join(PACKAGE_ROOT, "specs/agents/apps/vault-specialist/skills/vault-user/SKILL.md");
    const stripped = readFileSync(vault, "utf8").replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
    const result = parseSkillFrontmatter(stripped);
    expect(result.ok).toBe(false);
  });
});
