// Types for @stack-ui/core/theme (theme.js): the shared theme preference.
export type ThemePreference = 'system' | 'light' | 'dark';
export declare const THEME_STORAGE_KEY: string;
export declare const THEME_PREFERENCES: readonly ThemePreference[];
/** Script text for the <head> of a page rendered ahead of time: applies the stored theme before first paint. */
export declare const THEME_INIT_SCRIPT: string;
type StorageScope = { localStorage?: Storage } | typeof globalThis;
export declare function readThemePreference(scope?: StorageScope): ThemePreference;
export declare function storeThemePreference(preference: ThemePreference, scope?: StorageScope): boolean;
export declare function applyThemePreference(preference: ThemePreference, root?: Element): void;
export declare function initThemePreference(scope?: StorageScope, root?: Element): ThemePreference;
export declare function setThemePreference(preference: string, scope?: StorageScope, root?: Element): ThemePreference;
