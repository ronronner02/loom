#!/usr/bin/env node
// Packaging step (build-package.sh): point the CLI's compiled imports of
// `@multi-agent/daemon/<subpath>` at the daemon copy the CLI package already ships in
// `daemon/dist`, so the published package has no dependency on the unpublished
// `@multi-agent/daemon` and any package manager can install it (#66).
//
// Files are parsed with the TypeScript compiler the build already uses, and only real
// module specifiers are rewritten: import and export declarations, and `import()` or
// `require()` calls with a literal argument. Comments and strings are left alone.
// Targets come from packages/daemon/package.json `exports`. The step fails on a parse
// error, on a specifier with no exports entry, on a target that was not staged, on a
// non-literal `import()`/`require()` argument naming the package, and on any daemon
// import left afterwards. Running it twice is a no-op. Source imports and development
// resolution are unchanged.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE = "@multi-agent/daemon";
const isDaemonSpecifier = (value) => value === PACKAGE || value.startsWith(`${PACKAGE}/`);

// The daemon module specifiers in one file, from its syntax tree.
function daemonSpecifiers(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`${file}: cannot parse (${source.parseDiagnostics[0].messageText})`);
  }
  const found = [];
  const visit = (node) => {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      literal = node.moduleSpecifier;
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) literal = argument;
      else if (argument && argument.getText(source).includes(PACKAGE)) {
        throw new Error(`${file}: cannot rewrite non-literal module argument ${argument.getText(source)}`);
      }
    }
    if (literal && ts.isStringLiteralLike(literal) && isDaemonSpecifier(literal.text)) {
      found.push({ value: literal.text, start: literal.getStart(source), end: literal.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function loadSubpathTargets(daemonPackageJsonPath) {
  const exportsMap = JSON.parse(readFileSync(daemonPackageJsonPath, "utf8")).exports ?? {};
  const targets = new Map();
  for (const [key, value] of Object.entries(exportsMap)) {
    const target = typeof value === "string" ? value : value?.import;
    if (typeof target === "string") targets.set(key, target);
  }
  return targets;
}

// Rewrites one file's text. `targetFor(subpath)` returns the absolute target path or throws.
export function rewriteSource(text, file, targetFor) {
  const found = daemonSpecifiers(text, file);
  let output = text;
  // Replace from the end so earlier offsets stay valid; keep each literal's own quotes.
  for (const { value, start, end } of [...found].reverse()) {
    const target = targetFor(value.slice(PACKAGE.length), file);
    let specifier = relative(dirname(file), target).split(sep).join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    output = `${output.slice(0, start + 1)}${specifier}${output.slice(end - 1)}`;
  }
  return { output, count: found.length };
}

export function remainingDaemonImports(text, file = "<input>") {
  return daemonSpecifiers(text, file).map(({ value }) => value);
}

function javascriptFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...javascriptFiles(path));
    else if (path.endsWith(".js")) files.push(path);
  }
  return files;
}

export function rewriteDaemonImports({ cliDir, daemonPackageJsonPath }) {
  const targets = loadSubpathTargets(daemonPackageJsonPath);
  const stagedDaemon = join(cliDir, "daemon");
  const targetFor = (subpath, file) => {
    const target = targets.get(`.${subpath}`);
    if (!target) {
      throw new Error(`${file}: @multi-agent/daemon${subpath} has no entry in the daemon exports map`);
    }
    const absolute = resolve(stagedDaemon, target);
    if (!existsSync(absolute)) {
      throw new Error(`${file}: @multi-agent/daemon${subpath} maps to ${target}, which is not staged at ${absolute}`);
    }
    return absolute;
  };

  let rewritten = 0;
  let files = 0;
  const roots = [join(cliDir, "dist")];
  for (const file of roots.flatMap(javascriptFiles)) {
    const text = readFileSync(file, "utf8");
    const { output, count } = rewriteSource(text, file, targetFor);
    if (count === 0) continue;
    writeFileSync(file, output);
    rewritten += count;
    files += 1;
  }

  const left = roots.flatMap(javascriptFiles).flatMap((file) =>
    remainingDaemonImports(readFileSync(file, "utf8"), file).map((found) => `${file}: ${found}`));
  if (left.length > 0) throw new Error(`daemon imports left after rewrite:\n${left.join("\n")}`);
  return { rewritten, files };
}

/**
 * Point the vendored daemon's imports of an unpublished workspace package at the copy the CLI
 * package ships beside it.
 *
 * `@multi-agent/i18n` is `private: true`, so a global install cannot resolve it, and the daemon's
 * compiled output imports it by name for the role and client vocabulary. `build-package.sh`
 * stages the built package at `cli/daemon/i18n-dist`, and this step rewrites the name to the relative
 * path that reaches it, so the published artifact has no dependency on an unpublished package.
 * The package's own dependencies (`i18next`, `string-width`) are the CLI's dependencies, exactly
 * as every other runtime dependency of the vendored daemon is.
 */
export function rewriteWorkspaceImports({ cliDir, stagedDaemon, packages }) {
  const roots = [stagedDaemon];
  let rewritten = 0;
  let files = 0;
  for (const file of roots.flatMap(javascriptFiles)) {
    const text = readFileSync(file, "utf8");
    // Only real module specifiers are rewritten: a doc comment that names the package is text,
    // not an import, and rewriting it would describe the wrong module to every later reader.
    const found = workspaceSpecifiers(text, file, Object.keys(packages));
    let output = text;
    for (const { value, start, end } of [...found].reverse()) {
      const stagedPath = packages[value];
      if (!existsSync(stagedPath)) {
        throw new Error(`${file}: ${value} is not staged at ${stagedPath}`);
      }
      const specifier = nextRelative(dirname(file), stagedPath);
      output = `${output.slice(0, start + 1)}${specifier}${output.slice(end - 1)}`;
    }
    if (found.length === 0) continue;
    writeFileSync(file, output);
    rewritten += found.length;
    files += 1;
  }
  return { rewritten, files };
}

/**
 * The module specifiers in one file that name a package in `specifiers`, from its syntax tree.
 *
 * This mirrors the daemon rewrite: import and export declarations, and `import()` or `require()`
 * calls with a literal argument. Strings and comments are left alone.
 */
function workspaceSpecifiers(text, file, specifiers) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`${file}: cannot parse (${source.parseDiagnostics[0].messageText})`);
  }
  const found = [];
  const visit = (node) => {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      literal = node.moduleSpecifier;
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) literal = argument;
    }
    if (literal && ts.isStringLiteralLike(literal) && specifiers.includes(literal.text)) {
      found.push({ value: literal.text, start: literal.getStart(source), end: literal.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * A `./`-prefixed module specifier from `fromDir` to `target`, with `/` separators.
 *
 * `path.relative` can answer a bare name (two directories sitting beside each other at the same
 * depth still differ only below their shared parent, so this is the only shape that yields one);
 * a specifier starting with neither `.` nor `/` would name a package instead of a file.
 */
function nextRelative(fromDir, target) {
  const specifier = relative(fromDir, target).split(sep).join("/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

// Run only when executed directly. Compare real file paths, not a hand-built URL:
// import.meta.url is percent-encoded (spaces, "#") and names the symlink-resolved file.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false; // argv[1] is not an existing file, so this module was imported, not run
  }
}

if (invokedDirectly()) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { rewritten, files } = rewriteDaemonImports({
      cliDir: join(repoRoot, "packages", "cli"),
      daemonPackageJsonPath: join(repoRoot, "packages", "daemon", "package.json"),
    });
    console.log(`Rewrote ${rewritten} @multi-agent/daemon import(s) in ${files} file(s) to the shipped daemon/dist.`);
    const stagedDaemon = join(repoRoot, "packages", "cli", "daemon");
    const workspace = rewriteWorkspaceImports({
      cliDir: join(repoRoot, "packages", "cli"), stagedDaemon,
      packages: { "@multi-agent/i18n": join(stagedDaemon, "i18n-dist", "index.js") },
    });
    console.log(`Rewrote ${workspace.rewritten} unpublished workspace import(s) in ${workspace.files} file(s).`);
  } catch (error) {
    console.error(`rewrite-daemon-imports: ${error.message}`);
    process.exitCode = 1;
  }
}
