import { execFileSync } from "node:child_process";

/**
 * The upstream `spec-first` validator, when it is installed on this host.
 *
 * The task-pack case drives that real CLI rather than a repository file, and the engine does not
 * depend on it: a developer installs it, a CI runner does not. Resolving it through the package
 * manager's own bin entry keeps the case working wherever it is installed, and reports absence
 * so the case can skip with a reason instead of failing on a machine-specific path.
 */
export const specFirstCli = (() => {
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // Windows cannot spawn a `.cmd` without a shell; `shell: true` would then warn that the
    // arguments are unescaped. The package manager is looked up on PATH directly instead.
    const lookup = process.platform === "win32"
      ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm prefix -g"]]
      : [npm, ["prefix", "-g"]];
    const prefix = execFileSync(lookup[0], lookup[1], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const entry = process.platform === "win32"
      ? `${prefix}\\node_modules\\spec-first\\bin\\spec-first.js`
      : `${prefix}/lib/node_modules/spec-first/bin/spec-first.js`;
    execFileSync(process.execPath, [entry, "--version"], { stdio: "ignore" });
    return entry;
  } catch {
    return null;
  }
})();