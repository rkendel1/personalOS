/**
 * Light, dark, or the system's setting: the shared stack-ui theme preference. stack-ui keeps it
 * in this browser (localStorage `stack-ui.theme`) and applies it as `data-stack-theme` on <html>;
 * stack-ui's tokens and every color in styles.css follow it. The Shell's theme select is the
 * control. public/theme.js applies it before first paint.
 */
import { useCallback, useEffect, useState } from "react";
import { initThemePreference, setThemePreference, THEME_STORAGE_KEY, type ThemePreference } from "@stack-ui/core/theme";

/** The key PersonalOS used before it adopted stack-ui: read once, then moved. */
const LEGACY_KEY = "app:theme";

function migrate() {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && localStorage.getItem(THEME_STORAGE_KEY) === null && (legacy === "light" || legacy === "dark")) localStorage.setItem(THEME_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage is blocked (a private window): nothing to move.
  }
}

export function useThemePreference(): { preference: ThemePreference; onChange: (value: ThemePreference) => void } {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    migrate();
    return initThemePreference(window);
  });
  const onChange = useCallback((value: ThemePreference) => setPreference(setThemePreference(value, window)), []);
  // Another tab changed it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === THEME_STORAGE_KEY && setPreference(initThemePreference(window));
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return { preference, onChange };
}
