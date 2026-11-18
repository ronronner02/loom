import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBinEntry, resolveNodeReexecBinary } from "../src/bin-wrapper.js";
import { symlinkRefusal } from "./symlink.js";

describe("bin-wrapper", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it.skipIf(symlinkRefusal !== null)("resolves the real dist entry from a symlinked wrapper path", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-bin-wrapper-"));
    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const symlinkPath = path.join(tempDir, "rig");
    fs.symlinkSync(wrapperSource, symlinkPath);

    const entry = resolveBinEntry(symlinkPath, pathToFileURL(wrapperSource).href);
    expect(entry).toBe(path.resolve(path.dirname(wrapperSource), "../dist/index.js"));
  });

  it.skipIf(symlinkRefusal !== null)("prefers the sibling node next to the invoked rig binary when current node comes from elsewhere", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-bin-wrapper-"));
    const prefixDir = path.join(tempDir, "prefix");
    const binDir = path.join(prefixDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const rigPath = path.join(binDir, "rig");
    // The wrapper looks for the platform's own node name next to the invoked binary.
    const siblingNodePath = path.join(binDir, process.platform === "win32" ? "node.exe" : "node");
    fs.symlinkSync(wrapperSource, rigPath);
    fs.writeFileSync(siblingNodePath, "");

    const reexecNode = resolveNodeReexecBinary(
      "/opt/homebrew/bin/node",
      rigPath,
      {},
      (candidate) => candidate === siblingNodePath,
      (candidate) => candidate,
    );

    expect(reexecNode).toBe(siblingNodePath);
  });

  it.skipIf(symlinkRefusal !== null)("does not re-exec when already running under the sibling node", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-agent-bin-wrapper-"));
    const prefixDir = path.join(tempDir, "prefix");
    const binDir = path.join(prefixDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const wrapperSource = fileURLToPath(new URL("../src/bin-wrapper.ts", import.meta.url));
    const rigPath = path.join(binDir, "rig");
    // The wrapper looks for the platform's own node name next to the invoked binary.
    const siblingNodePath = path.join(binDir, process.platform === "win32" ? "node.exe" : "node");
    fs.symlinkSync(wrapperSource, rigPath);
    fs.writeFileSync(siblingNodePath, "");

    const reexecNode = resolveNodeReexecBinary(
      siblingNodePath,
      rigPath,
      {},
      (candidate) => candidate === siblingNodePath,
      (candidate) => candidate,
    );

    expect(reexecNode).toBeNull();
  });
});
