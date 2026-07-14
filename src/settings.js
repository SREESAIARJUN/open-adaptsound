/**
 * Persisted user preferences (localStorage).
 */

const KEY = "open-adaptsound-settings-v2";

export const DEFAULT_SETTINGS = {
  /** full | half | gentle */
  mode: "half",
  /** Hearing test is always Samsung-style beeps (locked). */
  toneMode: "beep",
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem("open-adaptsound-settings-v1");
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      mode: parsed.mode || DEFAULT_SETTINGS.mode,
      // Always beeps-only for the Adapt Sound test
      toneMode: "beep",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
