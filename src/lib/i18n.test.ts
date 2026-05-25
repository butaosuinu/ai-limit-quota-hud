import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@lingui/core";

import {
  activateLocale,
  detectLocale,
  isSupported,
  persistLocale,
} from "./i18n";

const STORAGE_KEY = "quotahud.locale";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  // setup.ts seeds the ja catalog; restore it so locale mutations here don't
  // bleed into other tests in this file that read `i18n.locale`.
  i18n.activate("ja");
});

describe("isSupported", () => {
  it("accepts the configured locales", () => {
    expect(isSupported("ja")).toBe(true);
    expect(isSupported("en")).toBe(true);
  });

  it("rejects unknown locales", () => {
    expect(isSupported("xx")).toBe(false);
    expect(isSupported("")).toBe(false);
  });
});

describe("persistLocale / detectLocale", () => {
  it("round-trips a persisted locale through localStorage", () => {
    persistLocale("en");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
    expect(detectLocale()).toBe("en");
  });

  it("ignores an unsupported stored value and falls back to the browser language", () => {
    window.localStorage.setItem(STORAGE_KEY, "xx");
    // jsdom's navigator.language defaults to en-US, so the fallback resolves en.
    expect(detectLocale()).toBe("en");
  });
});

describe("activateLocale", () => {
  it("loads and activates the requested locale", async () => {
    await activateLocale({ locale: "en" });
    expect(i18n.locale).toBe("en");
  });

  it("short-circuits when the signal is already aborted", async () => {
    i18n.activate("ja");
    const controller = new AbortController();
    controller.abort();
    await activateLocale({ locale: "en", signal: controller.signal });
    // The dynamic import still runs, but the aborted signal prevents
    // load/activate, so the active locale is left unchanged.
    expect(i18n.locale).toBe("ja");
  });
});
