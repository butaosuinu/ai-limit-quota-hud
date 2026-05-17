import { i18n } from "@lingui/core";

const STORAGE_KEY = "quotahud.locale";

export const SUPPORTED_LOCALES = ["ja", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

function isSupported(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function detectLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored !== null && isSupported(stored)) return stored;
  return window.navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function persistLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, locale);
}

// Monotonic counter so rapid locale toggles (ja → en → ja) only commit the
// most recent request. Without this guard a late-resolving import could
// overwrite a fresher activation and desync `i18n.locale` from localStorage.
let activationToken = 0;

export async function activateLocale(locale: Locale): Promise<void> {
  activationToken += 1;
  const token = activationToken;
  const mod = (await import(`../locales/${locale}/messages.ts`)) as {
    messages: Record<string, string>;
  };
  if (token !== activationToken) return;
  i18n.load(locale, mod.messages);
  i18n.activate(locale);
}

export { i18n };
