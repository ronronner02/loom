import { beforeEach, describe, expect, it } from "vitest";
import { readPreference, writePreference } from "../preferences.js";

/** Keys a browser that used the former name would hold. */
const OLD_THEME = ["multi", "agent", "teamTheme"].join(".");
const OLD_LANGUAGE = ["multi", "agent", "interfaceLanguage"].join(".");
const OLD_SETUP = ["multi", "agent", "setupComplete"].join(".");

beforeEach(() => localStorage.clear());

describe("browser preferences carried over from the former name", () => {
  it.each([
    ["loom.teamTheme", OLD_THEME],
    ["loom.interfaceLanguage", OLD_LANGUAGE],
    ["loom.setupComplete", OLD_SETUP],
  ])("moves %s from %s on the first read, then deletes the old key", (key, legacy) => {
    localStorage.setItem(legacy, "dark");
    expect(readPreference(key)).toBe("dark");
    expect(localStorage.getItem(key)).toBe("dark");
    expect(localStorage.getItem(legacy)).toBeNull();
  });

  it("prefers the current key and leaves an old value alone when both exist", () => {
    localStorage.setItem("loom.teamTheme", "light");
    localStorage.setItem(OLD_THEME, "dark");
    expect(readPreference("loom.teamTheme")).toBe("light");
    expect(localStorage.getItem(OLD_THEME)).toBe("dark");
  });

  it("returns null when neither key holds anything", () => {
    expect(readPreference("loom.setupComplete")).toBeNull();
    expect(localStorage.getItem(OLD_SETUP)).toBeNull();
  });

  it("writes only the new key", () => {
    writePreference("loom.interfaceLanguage", "zh-CN");
    expect(localStorage.getItem("loom.interfaceLanguage")).toBe("zh-CN");
    expect(localStorage.getItem(OLD_LANGUAGE)).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("denied"); };
    try {
      expect(readPreference("loom.teamTheme")).toBeNull();
      expect(() => writePreference("loom.teamTheme", "dark")).not.toThrow();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});