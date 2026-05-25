import { i18n } from "@lingui/core";

const STORAGE_KEY = "quotahud.locale";

export const SUPPORTED_LOCALES = ["ja", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isSupported(value: string): value is Locale {
  return SUPPORTED_LOCALES.some((supported) => supported === value);
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

type LocaleMessages = { messages: Record<string, string> };

// `signal` cancels a superseded activation: rapid locale toggles (ja → en → ja)
// abort earlier requests so a late-resolving dynamic import can't overwrite a
// fresher activation and desync `i18n.locale` from localStorage.
export async function activateLocale({
  locale,
  signal,
}: {
  locale: Locale;
  signal?: AbortSignal;
}): Promise<void> {
  const mod: LocaleMessages = await import(`../locales/${locale}/messages.ts`);
  if (signal?.aborted === true) return;
  i18n.load(locale, mod.messages);
  i18n.activate(locale);
}

export { i18n };
