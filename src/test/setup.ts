import { vi } from "vitest";
import { i18n } from "@lingui/core";

import { messages as jaMessages } from "../locales/ja/messages";

// Activate the Japanese catalog up-front so components / atoms that call
// Lingui's `_(MessageDescriptor)` at module load (or before any per-test
// activation) don't throw "Attempted to call a translation function without
// setting a locale". Tests that exercise locale switching can re-activate
// inside their describe.
i18n.load("ja", jaMessages);
i18n.activate("ja");

// Default Tauri API mocks. Individual tests can override these via vi.mocked()
// or by re-mocking the module inside the test file.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    label: "overlay",
    outerPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
    scaleFactor: vi.fn(() => Promise.resolve(1)),
    setPosition: vi.fn(() => Promise.resolve(undefined)),
  })),
}));
