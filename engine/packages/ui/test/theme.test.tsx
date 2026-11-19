import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEAM_THEME_KEY, useThemePreference, type TeamThemePreference } from "../src/team/theme.js";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const prepaint = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
let dark: boolean;
let query: MediaQueryList;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  dark = false;
  const events = new EventTarget();
  query = Object.assign(events, { media: "(prefers-color-scheme: dark)", onchange: null,
    addListener: vi.fn(), removeListener: vi.fn() }) as unknown as MediaQueryList;
  Object.defineProperty(query, "matches", { get: () => dark });
  vi.spyOn(window, "matchMedia").mockReturnValue(query);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function expectPalette(theme: "light" | "dark") {
  expect(document.documentElement.classList.contains("dark")).toBe(theme === "dark");
  expect(document.documentElement.style.colorScheme).toBe(theme);
}

describe("one appearance preference before and after application mount", () => {
  it.each([
    ["unset", null, false, "light"],
    ["unset on a dark OS", null, true, "light"],
    ["obsolete", "ink", true, "light"],
    ["explicit light", "light", true, "light"],
    ["explicit dark", "dark", false, "dark"],
    ["system light", "system", false, "light"],
    ["system dark", "system", true, "dark"],
  ] as const)("keeps the %s palette across first paint and mount", (_name, preference, osDark, expected) => {
    dark = osDark;
    localStorage.setItem("loom.theme", expected === "dark" ? "light" : "dark");
    if (preference !== null) localStorage.setItem(TEAM_THEME_KEY, preference);
    expect(prepaint).toBeDefined();
    runInNewContext(prepaint!, { localStorage, window, document });
    expectPalette(expected);
    const { result } = renderHook(useThemePreference);
    expect(result.current.theme).toBe(expected);
    expectPalette(expected);
  });

  it("applies settings and live system changes to the same document palette", () => {
    const { result } = renderHook(useThemePreference);
    expectPalette("light");
    for (const preference of ["dark", "light", "system"] as const) {
      act(() => result.current.setPreference(preference));
      expect(localStorage.getItem(TEAM_THEME_KEY)).toBe(preference);
      expectPalette(preference === "dark" ? "dark" : "light");
    }
    act(() => { dark = true; query.dispatchEvent(new Event("change")); });
    expect(result.current.theme).toBe("dark");
    expectPalette("dark");
    act(() => result.current.setPreference("light"));
    act(() => { dark = false; query.dispatchEvent(new Event("change")); dark = true; query.dispatchEvent(new Event("change")); });
    expectPalette("light");
  });

  it("keeps the in-memory choice usable when storage reads and writes fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const { result } = renderHook(useThemePreference);
    expect(result.current.preference).toBe("light");
    expectPalette("light");
    act(() => result.current.setPreference("dark"));
    expectPalette("dark");
  });

  it.each(["light", "dark", "unmount"] as const)("releases the system listener on %s", next => {
    localStorage.setItem(TEAM_THEME_KEY, "system");
    const add = vi.spyOn(query, "addEventListener");
    const remove = vi.spyOn(query, "removeEventListener");
    const { result, unmount } = renderHook(useThemePreference);
    const listener = add.mock.calls.find(([event]) => event === "change")?.[1];
    expect(listener).toBeDefined();
    if (next === "unmount") unmount();
    else act(() => result.current.setPreference(next as TeamThemePreference));
    expect(remove).toHaveBeenCalledWith("change", listener);
  });
});