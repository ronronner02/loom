/**
 * Browser preference storage that survives the product's rename.
 *
 * A browser that used the former app holds its choices under the old keys. The first read of a
 * key moves the old value to the new key and removes the old one, so a reader keeps their theme,
 * language and setup state exactly once and nothing is written under the old name afterwards.
 */

/** The old key for each current key; a key with no old name has no entry. */
const LEGACY_KEYS: Readonly<Record<string, string>> = {
  "loom.teamTheme": ["multi", "agent", "teamTheme"].join("."),
  "loom.interfaceLanguage": ["multi", "agent", "interfaceLanguage"].join("."),
  "loom.setupComplete": ["multi", "agent", "setupComplete"].join("."),
};

export function readPreference(key: string): string | null {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    const legacy = LEGACY_KEYS[key];
    const previous = legacy === undefined ? null : localStorage.getItem(legacy);
    if (previous === null) return null;
    localStorage.setItem(key, previous);
    localStorage.removeItem(legacy!);
    return previous;
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice still applies to this load when storage is unavailable.
  }
}