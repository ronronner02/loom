import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = join(here, "..", "index.html");
const publicDir = join(here, "..", "public");

describe("index.html", () => {
  it("declares a real favicon so headed dogfood stays console-clean", () => {
    const html = readFileSync(indexHtml, "utf8");
    const href = html.match(/<link[^>]*rel="icon"[^>]*href="([^"]+)"/)?.[1];

    // A missing icon logs a 404; a bare `data:,` is the retired empty placeholder.
    expect(href).toBeTruthy();
    expect(href).not.toBe("data:,");
    expect(href!.startsWith("/")).toBe(true);
    expect(existsSync(join(publicDir, href!.slice(1)))).toBe(true);
  });
});