import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPomoAvatarUrl } from "../pomo-avatar.js";
import { getVendorAvatarUrl } from "../flow/vendor-avatars.js";

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../public");

const paths = [
  ...(["master", "waking", "working", "waiting", "messaging", "milestone"] as const).map(getPomoAvatarUrl),
  ...(["chatgpt", "claude", "deepseek", "gemini", "grok", "kimi", "qwen"] as const).flatMap(vendor =>
    (["master", "working", "waiting", "messaging", "milestone"] as const).map(state => getVendorAvatarUrl(vendor, state))),
];

describe("shipped character assets", () => {
  it.each(paths)("includes the PNG referenced by %s", path => {
    const bytes = readFileSync(resolve(publicRoot, `.${path}`));
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
