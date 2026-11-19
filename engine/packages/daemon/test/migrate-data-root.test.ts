import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DB_FILENAME, LEGACY_DB_FILENAME, migrateDataRoot, renameLegacyDatabase, repointWorktreeLinks,
  rewriteDataRootPaths, rewriteDesktopConfig, rewritePath,
} from "../src/migrate-data-root.js";
import { legacyDataRoots, migrateDataRootsOnce, resolveDataRoots } from "../src/data-paths.js";

/** A disposable volume layout: `<root>/Local` and `<root>/Roaming`, with one home folder. */
function layout() {
  const root = mkdtempSync(join(tmpdir(), "loom-migration-"));
  return {
    root,
    local: join(root, "Local"),
    roaming: join(root, "Roaming"),
    home: join(root, "home"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedInstallation(dataRoot: string, dbFile = LEGACY_DB_FILENAME): string {
  mkdirSync(join(dataRoot, "engine"), { recursive: true });
  mkdirSync(join(dataRoot, "profile"), { recursive: true });
  writeFileSync(join(dataRoot, "engine", "config.json"), "{}\n");
  writeFileSync(join(dataRoot, "profile", "sentinel.txt"), "kept\n");
  const dbPath = join(dataRoot, "engine", dbFile);
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE rows (id TEXT PRIMARY KEY); INSERT INTO rows VALUES ('a'), ('b');");
  db.close();
  return dbPath;
}

/** A database with the path-bearing columns the daemon writes. */
function seedPathDatabase(dbPath: string, values: { worktree: string; repository: string; installRoot: string }): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE rigs (id TEXT PRIMARY KEY, install_root TEXT, rig_policy_declaring_dir TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, cwd TEXT, policy_declaring_dir TEXT);
    CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY, target_repo TEXT);
    CREATE TABLE team_runs (id TEXT PRIMARY KEY, integration_worktree TEXT, integration_repository TEXT);
  `);
  db.prepare("INSERT INTO rigs VALUES ('r1', ?, NULL)").run(values.installRoot);
  db.prepare("INSERT INTO nodes VALUES ('n1', ?, NULL)").run(values.worktree);
  db.prepare("INSERT INTO queue_items VALUES ('q1', ?)").run(values.worktree);
  db.prepare("INSERT INTO team_runs VALUES ('run1', ?, ?)").run(values.worktree, values.repository);
  db.close();
}

describe("migrateDataRoot — every branch of the one-time move", () => {
  it("fresh install: nothing to move and nothing is created", () => {
    const { local, cleanup } = layout();
    try {
      const dataRoot = join(local, "Loom");
      const legacyRoot = join(local, "Multi-Agent");
      expect(migrateDataRoot({ dataRoot, legacyRoot })).toMatchObject({ outcome: "none", from: null });
      expect(existsSync(dataRoot)).toBe(false);
      expect(existsSync(legacyRoot)).toBe(false);
    } finally { cleanup(); }
  });

  it("old only: the whole tree moves, the new root does not exist first", () => {
    const { local, cleanup } = layout();
    try {
      const dataRoot = join(local, "Loom");
      const legacyRoot = join(local, "Multi-Agent");
      const legacyDb = seedInstallation(legacyRoot);
      // The database sits in `engine/` on every host that writes one; the sibling naming is its
      // own case below, so this one appends a single WAL to prove the pair moves together.
      writeFileSync(`${legacyDb}-wal`, "");
      const result = migrateDataRoot({ dataRoot, legacyRoot, log: () => {} });
      expect(result).toMatchObject({ outcome: "moved", from: legacyRoot, to: dataRoot });
      expect(existsSync(legacyRoot)).toBe(false);
      expect(readFileSync(join(dataRoot, "profile", "sentinel.txt"), "utf8")).toBe("kept\n");
      expect(readFileSync(join(dataRoot, "engine", "config.json"), "utf8")).toBe("{}\n");
      // The database and its WAL siblings took the new name.
      expect(existsSync(join(dataRoot, "engine", DB_FILENAME))).toBe(true);
      expect(existsSync(join(dataRoot, "engine", LEGACY_DB_FILENAME))).toBe(false);
      expect(existsSync(join(dataRoot, "engine", `${DB_FILENAME}-wal`))).toBe(false);
      expect(existsSync(join(dataRoot, "engine", `${LEGACY_DB_FILENAME}-wal`))).toBe(false);
    } finally { cleanup(); }
  });

  it("both roots exist: the new one wins, the old one is reported and untouched", () => {
    const { local, cleanup } = layout();
    try {
      const dataRoot = join(local, "Loom");
      const legacyRoot = join(local, "Multi-Agent");
      seedInstallation(legacyRoot);
      mkdirSync(join(dataRoot, "engine"), { recursive: true });
      writeFileSync(join(dataRoot, "current.txt"), "new\n");
      const messages: string[] = [];
      const result = migrateDataRoot({ dataRoot, legacyRoot, log: message => messages.push(message) });
      expect(result.outcome).toBe("left-in-place");
      expect(existsSync(join(legacyRoot, "profile", "sentinel.txt"))).toBe(true);
      expect(readFileSync(join(dataRoot, "current.txt"), "utf8")).toBe("new\n");
      expect(messages.join("\n")).toContain("left in place");
      expect(messages.join("\n")).toContain(legacyRoot);
    } finally { cleanup(); }
  });

  it("a move that cannot complete names both paths and leaves nothing half-moved", () => {
    const { root, cleanup } = layout();
    try {
      const dataRoot = join(root, "Loom");
      const legacyRoot = join(root, "Multi-Agent");
      seedInstallation(legacyRoot);
      // A file where the new root's parent must be a directory: the move is attempted, fails on
      // every host, and leaves no new root behind and no change in the old one.
      const blocked = join(root, "blocked");
      writeFileSync(blocked, "not a directory");
      expect(() => migrateDataRoot({ dataRoot: join(blocked, "Loom"), legacyRoot, log: () => {} }))
        .toThrow(/could not be moved from .*Multi-Agent.*Loom/i);
      expect(readFileSync(join(legacyRoot, "profile", "sentinel.txt"), "utf8")).toBe("kept\n");
      expect(readFileSync(blocked, "utf8")).toBe("not a directory");
    } finally { cleanup(); }
  });

  it("an explicit root owns its history: no legacy pair is resolved", () => {
    const { local, home, cleanup } = layout();
    try {
      const env = { LOOM_HOME: join(local, "chosen"), LOCALAPPDATA: local };
      expect(legacyDataRoots({ platform: "win32", env, home })).toBeNull();
      expect(migrateDataRootsOnce({ platform: "win32", env, home, log: () => {} }).outcome).toBe("none");
      expect(existsSync(join(local, "chosen"))).toBe(false);
    } finally { cleanup(); }
  });

  it("moves the Windows state and configuration roots together", () => {
    const { local, roaming, home, cleanup } = layout();
    try {
      seedInstallation(join(local, "Multi-Agent"));
      mkdirSync(join(roaming, "Multi-Agent"), { recursive: true });
      writeFileSync(join(roaming, "Multi-Agent", "config.json"), '{"kept":true}\n');
      const env = { LOCALAPPDATA: local, APPDATA: roaming };
      const result = migrateDataRootsOnce({ platform: "win32", env, home, log: () => {} });
      expect(result.outcome).toBe("moved");
      expect(readFileSync(join(local, "Loom", "engine", DB_FILENAME)).length).toBeGreaterThan(0);
      expect(readFileSync(join(roaming, "Loom", "config.json"), "utf8")).toBe('{"kept":true}\n');
      expect(existsSync(join(roaming, "Multi-Agent"))).toBe(false);
    } finally { cleanup(); }
  });

  it("uses the POSIX home folder pair when no override is set", () => {
    const { home, cleanup } = layout();
    try {
      expect(resolveDataRoots({ platform: "linux", env: {}, home }).state).toBe(join(home, ".loom"));
      expect(legacyDataRoots({ platform: "linux", env: {}, home })?.state).toBe(join(home, ".multi-agent"));
      mkdirSync(join(home, ".multi-agent"), { recursive: true });
      writeFileSync(join(home, ".multi-agent", "kept.txt"), "x\n");
      expect(migrateDataRootsOnce({ platform: "linux", env: {}, home, log: () => {} }).outcome).toBe("moved");
      expect(readFileSync(join(home, ".loom", "kept.txt"), "utf8")).toBe("x\n");
    } finally { cleanup(); }
  });
});

describe("renameLegacyDatabase — the database and its siblings", () => {
  it("renames -wal, -shm, a journal and an upgrade backup, and leaves other files", () => {
    const { local, cleanup } = layout();
    try {
      const root = join(local, "state");
      mkdirSync(root, { recursive: true });
      for (const file of [LEGACY_DB_FILENAME, `${LEGACY_DB_FILENAME}-wal`, `${LEGACY_DB_FILENAME}-shm`,
        `${LEGACY_DB_FILENAME}-journal`, `${LEGACY_DB_FILENAME}.v9-1794809925166.bak`, "daemon.json"]) {
        writeFileSync(join(root, file), file);
      }
      renameLegacyDatabase(root);
      expect(readdirSync(root).sort()).toEqual([
        DB_FILENAME, `${DB_FILENAME}-journal`, `${DB_FILENAME}-shm`, `${DB_FILENAME}-wal`,
        `${DB_FILENAME}.v9-1794809925166.bak`, "daemon.json",
      ].sort());
      expect(readFileSync(join(root, DB_FILENAME), "utf8")).toBe(LEGACY_DB_FILENAME);
    } finally { cleanup(); }
  });

  it("does nothing when the new database already exists", () => {
    const { local, cleanup } = layout();
    try {
      const root = join(local, "state");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, DB_FILENAME), "current");
      writeFileSync(join(root, LEGACY_DB_FILENAME), "legacy");
      renameLegacyDatabase(root);
      expect(readFileSync(join(root, DB_FILENAME), "utf8")).toBe("current");
      expect(existsSync(join(root, LEGACY_DB_FILENAME))).toBe(true);
    } finally { cleanup(); }
  });

  it("does nothing when only the new name exists", () => {
    const { local, cleanup } = layout();
    try {
      const root = join(local, "state");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, DB_FILENAME), "current");
      expect(() => renameLegacyDatabase(root)).not.toThrow();
      expect(readdirSync(root)).toEqual([DB_FILENAME]);
    } finally { cleanup(); }
  });
});

describe("rewriteDataRootPaths — stored absolute paths under the old root", () => {
  it("rewrites worktree, repository and install paths and counts the rows", () => {
    const { root, cleanup } = layout();
    try {
      const legacyRoot = join(root, "Multi-Agent");
      const dataRoot = join(root, "Loom");
      mkdirSync(dataRoot, { recursive: true });
      const worktree = join(legacyRoot, "wt", "run-1");
      const repository = join(legacyRoot, "projects", "app");
      const dbPath = join(dataRoot, DB_FILENAME);
      seedPathDatabase(dbPath, { worktree, repository, installRoot: join(root, "outside") });
      const rewritten = rewriteDataRootPaths(dbPath, legacyRoot, dataRoot);
      // nodes, queue_items (the worktree) and team_runs (worktree + repository): four rows.
      expect(rewritten).toBe(4);
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.prepare("SELECT cwd FROM nodes").get()).toEqual({ cwd: join(dataRoot, "wt", "run-1") });
        expect(db.prepare("SELECT target_repo FROM queue_items").get()).toEqual({ target_repo: join(dataRoot, "wt", "run-1") });
        expect(db.prepare("SELECT integration_repository FROM team_runs").get()).toEqual({ integration_repository: join(dataRoot, "projects", "app") });
        // A path outside the root is the owner's own checkout and is never touched.
        expect(db.prepare("SELECT install_root FROM rigs").get()).toEqual({ install_root: join(root, "outside") });
      } finally { db.close(); }
    } finally { cleanup(); }
  });

  it("leaves rows alone when nothing pointed into the old root", () => {
    const { root, cleanup } = layout();
    try {
      const dataRoot = join(root, "Loom");
      mkdirSync(dataRoot, { recursive: true });
      const dbPath = join(dataRoot, DB_FILENAME);
      seedPathDatabase(dbPath, { worktree: join(root, "elsewhere"), repository: join(root, "elsewhere"), installRoot: join(root, "elsewhere") });
      expect(rewriteDataRootPaths(dbPath, join(root, "Multi-Agent"), dataRoot)).toBe(0);
    } finally { cleanup(); }
  });

  it("ignores a relative or merely similar prefix", () => {
    const legacy = join("/", "home", "owner", "Multi-Agent");
    const target = join("/", "home", "owner", "Loom");
    expect(rewritePath(join(legacy, "wt", "run"), legacy, target)).toBe(join(target, "wt", "run"));
    expect(rewritePath("wt/run", legacy, target)).toBeNull();
    expect(rewritePath(join("/", "home", "owner", "Multi-Agent-backup", "wt"), legacy, target)).toBeNull();
    expect(rewritePath(`{${legacy}}`, legacy, target)).toBeNull();
  });
});

describe("rewriteDesktopConfig", () => {
  it("rewrites library arguments and keeps everything else", () => {
    const { root, cleanup } = layout();
    try {
      const legacyRoot = join(root, "Multi-Agent");
      const dataRoot = join(root, "state");
      mkdirSync(dataRoot, { recursive: true });
      const file = join(dataRoot, "claude_desktop_config.json");
      writeFileSync(file, JSON.stringify({ mcpServers: {
        loom: { command: "node", args: ["/elsewhere/server.js", join(legacyRoot, "context", "lib.md")] },
      } }));
      const rewritten = rewriteDesktopConfig(dataRoot, legacyRoot, dataRoot);
      expect(rewritten).toEqual([{ file, path: "loom.args[1]" }]);
      const config = JSON.parse(readFileSync(file, "utf8"));
      expect(config.mcpServers.loom.args).toEqual(["/elsewhere/server.js", join(dataRoot, "context", "lib.md")]);
      expect(config.mcpServers.loom.command).toBe("node");
    } finally { cleanup(); }
  });

  it("does nothing when the file is absent", () => {
    const { root, cleanup } = layout();
    try {
      expect(rewriteDesktopConfig(join(root, "state"), join(root, "Multi-Agent"), join(root, "state"))).toEqual([]);
    } finally { cleanup(); }
  });
});

describe("repointWorktreeLinks — a worktree whose repository moved", () => {
  it("rewrites the worktree link and the admin entry back to it, and leaves another repository alone", () => {
    const { root, cleanup } = layout();
    try {
      const legacyRoot = join(root, "Multi-Agent");
      const dataRoot = join(root, "Loom");
      // Two repositories: one under the root that moves, one the owner keeps outside it.
      const movedRepo = join(legacyRoot, "projects", "moved");
      const keptRepo = join(root, "kept");
      for (const repo of [movedRepo, keptRepo]) { mkdirSync(repo, { recursive: true }); git(repo, "init", "--quiet"); }
      const movedWorktree = join(legacyRoot, "engine", "wt", "run-1");
      const keptWorktree = join(legacyRoot, "engine", "wt", "run-2");
      for (const repo of [movedRepo, keptRepo]) git(repo, "commit", "--quiet", "--allow-empty", "-m", "init");
      git(movedRepo, "worktree", "add", "--quiet", "--detach", movedWorktree, "HEAD");
      git(keptRepo, "worktree", "add", "--quiet", "--detach", keptWorktree, "HEAD");

      // The root moves: the repository under it moves too, the one outside it does not.
      cpSync(legacyRoot, dataRoot, { recursive: true });
      rmSync(legacyRoot, { recursive: true, force: true });
      const newWorktree = join(dataRoot, "engine", "wt", "run-1");
      // Git names the admin entry after the worktree's own directory, so the moved entry is
      // `worktrees/run-1` whichever base the worktree sits under.
      // A runner whose TEMP is an 8.3 short path spells the same directory two ways; both sides
      // of every comparison are canonicalized, so the link is compared canonically too.
      // A runner whose TEMP is an 8.3 short path spells the same directory two ways; where both
      // sides exist, the comparison asks the OS so the spellings cannot decide it.
      const canonical = (value: string) => realpathSync.native(value).toLowerCase();
      const pointerOf = (worktree: string) => gitRead(join(worktree, ".git")).replace(/^gitdir:\s*/, "").trim();
      // Before the move the pointer names an admin entry inside the old root, which the move has
      // just removed; its spelling is what is checked.
      expect(pointerOf(newWorktree).split("\\").join("/").toLowerCase())
        .toContain(join(legacyRoot, "projects", "moved", ".git", "worktrees", "run-1").split("\\").join("/").toLowerCase());

      const repointed = repointWorktreeLinks(dataRoot, legacyRoot, dataRoot);
      expect(repointed).toBeGreaterThanOrEqual(1);
      // The pointer now names the admin entry under the moved repository, and git enters the
      // worktree again — which it cannot while either link is stale.
      expect(canonical(pointerOf(newWorktree)))
        .toBe(canonical(join(dataRoot, "projects", "moved", ".git", "worktrees", "run-1")));
      expect(git(newWorktree, "rev-parse", "--show-toplevel")).toContain("run-1");
      // The worktree of the repository that stayed put still names that repository, unchanged.
      expect(canonical(pointerOf(join(dataRoot, "engine", "wt", "run-2"))))
        .toBe(canonical(join(root, "kept", ".git", "worktrees", "run-2")));
    } finally { cleanup(); }
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  }).trim();
}

function gitRead(file: string): string {
  return readFileSync(file, "utf8");
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}