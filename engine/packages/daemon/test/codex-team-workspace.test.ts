import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexQueueStateRoot, codexTeamWorkspaceArg, prepareCodexTeamWorkspace } from "../src/domain/codex-team-workspace.js";
import { symlinkRefusal } from "./helpers/symlink.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-workspace-")); roots.push(root);
  const home = path.join(root, "home"); fs.mkdirSync(home);
  return { root, home, workspace: path.join(root, "custom workspace"), shared: path.join(home, ".loom", "shared-docs") };
}
describe("Codex team workspace preparation", () => {
  it("creates missing ancestors before granting exactly the configured workspace and pod state", () => {
    const f = fixture(), state = path.join(f.shared, "rigs/workshop/state/dev");
    expect(fs.existsSync(f.shared)).toBe(false);
    const dirs = prepareCodexTeamWorkspace("dev-builder@workshop", f.workspace, f.shared, f.home);
    expect(dirs).toEqual([f.workspace, state]);
    fs.writeFileSync(path.join(state, "brief.md"), "brief");
    fs.mkdirSync(path.join(f.workspace, "missions"));
    fs.writeFileSync(path.join(f.workspace, "missions", "proof.md"), "proof");
    expect(dirs).not.toContain(f.home);
    expect(fs.existsSync(path.join(f.home, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(f.home, ".claude"))).toBe(false);
    expect(prepareCodexTeamWorkspace("dev-builder@workshop", f.workspace, f.shared, f.home)).toEqual(dirs);
    expect(fs.readFileSync(path.join(state, "brief.md"), "utf8")).toBe("brief");
  });
  it("does not grant home, an ancestor, or a symlink to home", () => {
    const f = fixture(); vi.spyOn(console, "warn").mockImplementation(() => {});
    const candidates = [f.home, f.root, "/"];
    if (symlinkRefusal === null) {
      const alias = path.join(f.root, "alias"); fs.symlinkSync(f.home, alias);
      candidates.splice(2, 0, alias);
    }
    for (const candidate of candidates) {
      const dirs = prepareCodexTeamWorkspace("dev-builder@workshop", candidate, f.shared, f.home);
      expect(dirs).toEqual([path.join(f.shared, "rigs/workshop/state/dev")]);
    }
  });
  it.skipIf(symlinkRefusal !== null)("does not grant a symlink to home either", () => {
    // A link to home is a second name for the refused directory, so this host can only
    // prove it where links can be created.
    const f = fixture(); vi.spyOn(console, "warn").mockImplementation(() => {});
    const alias = path.join(f.root, "alias"); fs.symlinkSync(f.home, alias);
    expect(prepareCodexTeamWorkspace("dev-builder@workshop", alias, f.shared, f.home))
      .toEqual([path.join(f.shared, "rigs/workshop/state/dev")]);
  });
  it("keeps legacy/malformed names from inventing state paths", () => {
    for (const name of ["r00-team-seat", "seat@team", "dev-seat@team@host", "../dev-seat@team"]) {
      expect(codexQueueStateRoot(name, "/shared")).toBeUndefined();
    }
    expect(codexQueueStateRoot("dev-code-review@team", "/shared")).toBe(path.join("/shared", "rigs", "team", "state", "dev"));
  });
  it("quotes spaces and preserves launch availability when optional preparation fails", () => {
    expect(codexTeamWorkspaceArg(() => ["/custom work", "/state"], "seat")).toBe(" --add-dir '/custom work' --add-dir '/state'");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(codexTeamWorkspaceArg(() => { throw new Error("settings unavailable"); }, "seat")).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("settings unavailable"));
  });
});
